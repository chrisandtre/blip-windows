//! blip-mux: ONE ssh connection to the gateway Mac, shared by every Blip call.
//!
//! Windows OpenSSH has no ControlMaster, so a fresh `ssh` per call costs a
//! full handshake (330-430 ms to the Mac, measured) where Linux Blip pays
//! ~47 ms. The mux is the ControlMaster: it keeps the connection up, and each
//! blip-shim call becomes one exec channel on it.
//!
//!   blip-mux              started on demand by a shim; exits after 10 min idle
//!   blip-mux --persist    started by the Blip app; stays up
//!
//! Serves a named pipe whose random name is written to %LOCALAPPDATA%\Blip\mux.pipe.
//! The pipe's DACL admits only its owner (and SYSTEM), and remote clients are refused.
//! One mux per user: %LOCALAPPDATA%\Blip\mux.lock is held open exclusively.
//! The log (mux.log) records connection events only, never arguments or message text.

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::net::SocketAddr;
use std::os::windows::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use blip_wire as wire;
use russh::client;
use russh::keys::{check_known_hosts_path, load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::Mutex;

const IDLE_EXIT: Duration = Duration::from_secs(600);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CHANNEL_TIMEOUT: Duration = Duration::from_secs(4);

// ------------------------------------------------------------------ config

/// bridge.conf, parsed as data exactly like bridge/linux/blip-shim: known keys
/// only, whitespace dropped, one layer of quotes stripped.
#[derive(Clone, Debug, Default)]
struct Conf {
    user: String,
    host: String,
    port: u16,
    key: PathBuf,
    hide_spam: bool,
    hide_unknown: bool,
}

fn truthy(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "on" | "yes" | "true" | "1")
}

fn valid_host_part(s: &str, colon_ok: bool) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || (colon_ok && c == ':'))
}

fn parse_conf(text: &str) -> Result<Conf, String> {
    let mut target = String::new();
    let mut key = String::new();
    let mut c = Conf::default();
    for raw in text.lines() {
        let line: String = raw.split('#').next().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim_matches('"').trim_matches('\'');
        match k {
            "host" => target = v.to_string(),
            "key" => key = v.to_string(),
            "hide_spam" => c.hide_spam = truthy(v),
            "hide_unknown" => c.hide_unknown = truthy(v),
            _ => {}
        }
    }
    if let Ok(h) = std::env::var("BLIP_MAC_HOST") {
        if !h.is_empty() {
            target = h;
        }
    }
    if target.is_empty() {
        return Err("no Mac configured - run blip-setup (host= in bridge.conf)".into());
    }
    let (user, host) = match target.split_once('@') {
        Some((u, h)) => (u.to_string(), h.to_string()),
        None => (std::env::var("USERNAME").unwrap_or_default(), target.clone()),
    };
    if !valid_host_part(&user, false) || !valid_host_part(&host, true) {
        return Err(format!("refusing host '{target}' - expected [user@]hostname"));
    }
    // A bare IPv6 literal has colons; host:port is not a bridge.conf form.
    c.user = user;
    c.host = host;
    c.port = 22;
    c.key = if key.is_empty() {
        wire::profile_dir("USERPROFILE").join(".ssh").join("blip_win_ed25519")
    } else {
        PathBuf::from(key)
    };
    Ok(c)
}

fn load_conf() -> Result<Conf, String> {
    let path = wire::conf_path();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    parse_conf(&text)
}

fn known_hosts() -> PathBuf {
    wire::profile_dir("USERPROFILE").join(".ssh").join("known_hosts")
}

// ------------------------------------------------------------------ log

static LOG: StdMutex<Option<File>> = StdMutex::new(None);

fn log(msg: impl AsRef<str>) {
    let line = format!("{} {}\n", unix_now(), msg.as_ref());
    if let Ok(mut g) = LOG.lock() {
        if let Some(f) = g.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ------------------------------------------------------------------ ssh

struct Verifier {
    host: String,
    port: u16,
}

impl client::Handler for Verifier {
    type Error = anyhow::Error;

    /// Only a host key already in known_hosts (blip-setup put it there when
    /// you typed yes) is accepted. Unknown or CHANGED keys are refused.
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            bail!("the Mac offered a host certificate; Blip expects a plain host key");
        };
        match check_known_hosts_path(&self.host, self.port, key, known_hosts()) {
            Ok(true) => Ok(true),
            Ok(false) => bail!("{} is not in known_hosts - run blip-setup", self.host),
            Err(e) => bail!("HOST KEY MISMATCH for {}: {e} - refusing to connect", self.host),
        }
    }
}

type Conn = Arc<client::Handle<Verifier>>;

struct Link {
    conn: Mutex<Option<Conn>>,
    /// Last address that worked. Name lookup of a .local/LAN name can take
    /// seconds on Windows (7.4 s measured); a reconnect tries this first.
    last_addr: StdMutex<Option<SocketAddr>>,
    conf: StdMutex<Conf>,
    /// The last failed connect, so a burst of calls against an offline Mac
    /// fails in milliseconds instead of each waiting out its own timeout.
    last_fail: StdMutex<Option<(Instant, String)>>,
}

const FAIL_FAST: Duration = Duration::from_secs(5);

/// %LOCALAPPDATA%\Blip\mux.addr: "host addr" of the last address that worked,
/// so a cold mux skips the name lookup (7 s for chriss-imac, measured). Safe
/// because the host key is still checked against known_hosts BY NAME: a stale
/// or planted address can only fail, never impersonate the Mac.
fn addr_file() -> PathBuf {
    wire::local_dir().join("mux.addr")
}

fn cached_addr(host: &str) -> Option<SocketAddr> {
    let s = std::fs::read_to_string(addr_file()).ok()?;
    let (h, a) = s.trim().split_once(' ')?;
    if h != host {
        return None;
    }
    a.parse().ok()
}

impl Link {
    fn remembered(&self, c: &Conf) -> Option<SocketAddr> {
        let mem = *self.last_addr.lock().unwrap();
        mem.or_else(|| cached_addr(&c.host))
    }

    async fn resolve(&self, c: &Conf, skip: Option<SocketAddr>) -> Vec<SocketAddr> {
        let mut out = Vec::new();
        if let Ok(it) = tokio::net::lookup_host((c.host.as_str(), c.port)).await {
            let mut all: Vec<SocketAddr> = it.collect();
            // IPv4 first, then routable IPv6; link-local fe80:: rarely works without a scope.
            all.sort_by_key(|a| match a {
                SocketAddr::V4(_) => 0,
                SocketAddr::V6(v) if (v.ip().segments()[0] & 0xffc0) == 0xfe80 => 2,
                SocketAddr::V6(_) => 1,
            });
            for a in all {
                if Some(a) != skip && !out.contains(&a) {
                    out.push(a);
                }
            }
        }
        out
    }

    async fn try_addr(&self, c: &Conf, key: &Arc<russh::keys::PrivateKey>, addr: SocketAddr, limit: Duration) -> Result<Conn> {
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let v = Verifier { host: c.host.clone(), port: c.port };
        let attempt = async {
            let mut h = client::connect(config, addr, v).await?;
            let hash = h.best_supported_rsa_hash().await?.flatten();
            let auth = h.authenticate_publickey(c.user.clone(), PrivateKeyWithHashAlg::new(key.clone(), hash)).await?;
            if !auth.success() {
                bail!("the Mac refused the Blip key - re-run blip-setup");
            }
            Ok::<_, anyhow::Error>(h)
        };
        match tokio::time::timeout(limit, attempt).await {
            Ok(Ok(h)) => {
                *self.last_addr.lock().unwrap() = Some(addr);
                let _ = std::fs::write(addr_file(), format!("{} {addr}\n", c.host));
                log(format!("connected to {} ({addr})", c.host));
                Ok(Arc::new(h))
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err(anyhow!("timed out connecting to {addr}")),
        }
    }

    async fn connect(&self) -> Result<Conn> {
        let c = load_conf().map_err(|e| anyhow!(e))?;
        *self.conf.lock().unwrap() = c.clone();
        let key = load_secret_key(&c.key, None).with_context(|| format!("cannot read key {}", c.key.display()))?;
        let key = Arc::new(key);
        let mut last_err = anyhow!("no address answered");
        // The remembered address first, briefly: on the same network it
        // answers in milliseconds; after a move it fails fast and we look up.
        let remembered = self.remembered(&c);
        if let Some(addr) = remembered {
            match self.try_addr(&c, &key, addr, Duration::from_secs(2)).await {
                Ok(h) => return Ok(h),
                Err(e) => {
                    // Only a changed host key stops here. A refused key does
                    // not: the same Mac can be reached by two routes (LAN and
                    // Tailscale) and a key pinned with from= is accepted on one
                    // only, so the fresh lookup below may still get in.
                    if e.to_string().contains("HOST KEY MISMATCH") {
                        log(format!("connect failed: {e}"));
                        return Err(e);
                    }
                    log(format!("remembered address {addr} failed ({e}); looking the name up"));
                    last_err = e;
                }
            }
        }
        let addrs = self.resolve(&c, remembered).await;
        if addrs.is_empty() && remembered.is_none() {
            bail!("cannot resolve {}", c.host);
        }
        for addr in addrs {
            match self.try_addr(&c, &key, addr, CONNECT_TIMEOUT).await {
                Ok(h) => return Ok(h),
                Err(e) => last_err = e,
            }
        }
        log(format!("connect failed: {last_err}"));
        Err(last_err)
    }

    /// The live connection, connecting if there is none. One caller connects;
    /// the rest wait on the lock and share the result.
    async fn get(&self, fresh: bool) -> Result<Conn> {
        let mut g = self.conn.lock().await;
        if fresh {
            *g = None;
        }
        if let Some(c) = g.as_ref() {
            if !c.is_closed() {
                return Ok(c.clone());
            }
            log("connection closed; reconnecting");
        }
        if let Some((at, why)) = self.last_fail.lock().unwrap().as_ref() {
            if at.elapsed() < FAIL_FAST {
                bail!("{why}");
            }
        }
        match self.connect().await {
            Ok(c) => {
                *self.last_fail.lock().unwrap() = None;
                *g = Some(c.clone());
                Ok(c)
            }
            Err(e) => {
                *self.last_fail.lock().unwrap() = Some((Instant::now(), e.to_string()));
                Err(e)
            }
        }
    }

    /// An exec channel. A connection that went stale (sleep, Wi-Fi change)
    /// usually still says open; a channel that will not open within
    /// CHANNEL_TIMEOUT is the tell, and gets one reconnect.
    async fn channel(&self) -> Result<russh::Channel<client::Msg>> {
        for fresh in [false, true] {
            let conn = self.get(fresh).await?;
            match tokio::time::timeout(CHANNEL_TIMEOUT, conn.channel_open_session()).await {
                Ok(Ok(ch)) => return Ok(ch),
                Ok(Err(e)) if !fresh => log(format!("channel open failed ({e}); reconnecting")),
                Err(_) if !fresh => log("channel open timed out; reconnecting"),
                Ok(Err(e)) => return Err(e.into()),
                Err(_) => bail!("the Mac stopped answering"),
            }
        }
        unreachable!()
    }
}

// ------------------------------------------------------------------ requests

async fn read_request(p: &mut NamedPipeServer) -> Result<(Vec<String>, Vec<u8>)> {
    let argc = p.read_u32_le().await?;
    if argc == 0 || argc > wire::MAX_ARGS {
        bail!("argc out of range");
    }
    let mut argv = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        let n = p.read_u32_le().await?;
        if n > wire::MAX_ARG_LEN {
            bail!("argument too long");
        }
        let mut a = vec![0u8; n as usize];
        p.read_exact(&mut a).await?;
        argv.push(String::from_utf8(a)?);
    }
    let n = p.read_u64_le().await?;
    if n > wire::MAX_STDIN {
        bail!("stdin too large");
    }
    let mut stdin = vec![0u8; n as usize];
    p.read_exact(&mut stdin).await?;
    Ok((argv, stdin))
}

/// The remote command, built like the Linux shim builds it: the tool, the
/// hide_* flags for imsg, then every argument single-quoted for dispatch.
fn remote_command(argv: &[String], c: &Conf) -> String {
    let tool = &argv[0];
    let mut cmd = tool.clone();
    if tool == "imsg" {
        if c.hide_spam {
            cmd.push_str(" '--hide-spam'");
        }
        if c.hide_unknown {
            cmd.push_str(" '--hide-unknown'");
        }
    }
    if tool == "ping" {
        return cmd;
    }
    for a in &argv[1..] {
        cmd.push(' ');
        cmd.push_str(&wire::sh_quote(a));
    }
    cmd
}

async fn send(p: &mut NamedPipeServer, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    p.write_all(&wire::frame(kind, payload)).await
}

async fn finish(p: &mut NamedPipeServer, code: i32) {
    let _ = send(p, wire::FRAME_EXIT, &code.to_le_bytes()).await;
    let _ = p.flush().await;
}

async fn handle(mut p: NamedPipeServer, link: Arc<Link>) {
    let (argv, stdin) = match read_request(&mut p).await {
        Ok(r) => r,
        Err(e) => {
            log(format!("bad request: {e}"));
            return;
        }
    };
    let tool = argv[0].clone();
    if !wire::is_tool(&tool) {
        let _ = send(&mut p, wire::FRAME_STDERR, format!("blip-mux: '{tool}' is not a Blip tool\n").as_bytes()).await;
        return finish(&mut p, wire::EXIT_USAGE).await;
    }

    let channel = match link.channel().await {
        Ok(ch) => ch,
        Err(e) => {
            let host = link.conf.lock().unwrap().host.clone();
            let host = if host.is_empty() { "the Mac".to_string() } else { host };
            let msg = format!("{tool}: {host} unreachable - the iMessage bridge is offline. ({e})\n");
            let _ = send(&mut p, wire::FRAME_STDERR, msg.as_bytes()).await;
            let code = if e.to_string().contains("no Mac configured") || e.to_string().contains("refusing host") {
                wire::EXIT_CONFIG
            } else {
                wire::EXIT_OFFLINE
            };
            return finish(&mut p, code).await;
        }
    };

    let conf = link.conf.lock().unwrap().clone();
    let command = remote_command(&argv, &conf);
    let (mut rd, wr) = channel.split();
    if let Err(e) = wr.exec(true, command).await {
        let _ = send(&mut p, wire::FRAME_STDERR, format!("{tool}: exec failed ({e})\n").as_bytes()).await;
        return finish(&mut p, wire::EXIT_OFFLINE).await;
    }

    // stdin goes up while output comes down, so a tool that answers before it
    // has read everything cannot deadlock the channel window.
    let writer = async move {
        if !stdin.is_empty() {
            let _ = wr.data(&stdin[..]).await;
        }
        let _ = wr.eof().await;
        wr
    };
    let reader = async {
        let mut code: Option<i32> = None;
        while let Some(msg) = rd.wait().await {
            let r = match msg {
                ChannelMsg::Data { ref data } => send(&mut p, wire::FRAME_STDOUT, data).await,
                ChannelMsg::ExtendedData { ref data, ext: 1 } => send(&mut p, wire::FRAME_STDERR, data).await,
                ChannelMsg::ExitStatus { exit_status } => {
                    code = Some(exit_status as i32);
                    Ok(())
                }
                ChannelMsg::ExitSignal { .. } => {
                    code.get_or_insert(128 + 15);
                    Ok(())
                }
                _ => Ok(()),
            };
            if r.is_err() {
                // The shim went away (its caller killed it, e.g. a stopped
                // `imsg watch`). Dropping the channel closes it on the Mac.
                return None;
            }
        }
        Some(code.unwrap_or(255))
    };
    let (wr, code) = tokio::join!(writer, reader);
    drop(wr);
    if let Some(code) = code {
        finish(&mut p, code).await;
    }
}

// ------------------------------------------------------------------ pipe

/// Owner-only pipe: D:P (protected), full access for the owner (OW) and SYSTEM.
/// Without this the default DACL grants Everyone read access.
fn server(name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)(A;;GA;;;SY)\0".encode_utf16().collect();
    let mut sd = std::ptr::null_mut();
    // SAFETY: sddl is NUL-terminated UTF-16; sd is freed with LocalFree below.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut())
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: 0,
    };
    // SAFETY: sa points at a valid SECURITY_ATTRIBUTES for the duration of the call.
    let r = unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(name, &mut sa as *mut _ as *mut std::ffi::c_void)
    };
    unsafe { LocalFree(sd as _) };
    r
}

fn random_hex() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random source");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() -> Result<()> {
    let persist = std::env::args().any(|a| a == "--persist");
    let dir = wire::local_dir();
    std::fs::create_dir_all(&dir)?;

    // One mux per user. share_mode(0) = exclusive; released when this process
    // dies, however it dies, so a crash never strands the lock.
    let _lock = match OpenOptions::new().write(true).create(true).truncate(false).share_mode(0).open(dir.join("mux.lock")) {
        Ok(f) => f,
        Err(_) => return Ok(()), // another mux is running; the shim will find it
    };
    *LOG.lock().unwrap() = OpenOptions::new().create(true).append(true).open(dir.join("mux.log")).ok();

    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
    rt.block_on(async move {
        let name = format!(r"\\.\pipe\blip-mux-{}", random_hex());
        let mut next = server(&name, true).context("cannot create the mux pipe")?;
        std::fs::write(wire::pipe_name_file(), &name)?;
        log(format!("started (pid {}, persist={persist})", std::process::id()));

        let link = Arc::new(Link {
            conn: Mutex::new(None),
            last_addr: StdMutex::new(None),
            conf: StdMutex::new(Conf::default()),
            last_fail: StdMutex::new(None),
        });
        // Warm the connection now: the shim that started us is waiting.
        {
            let l = link.clone();
            tokio::spawn(async move {
                let _ = l.get(false).await;
            });
        }

        let active = Arc::new(AtomicUsize::new(0));
        let last_used = Arc::new(StdMutex::new(Instant::now()));
        loop {
            let idle = tokio::time::sleep(Duration::from_secs(30));
            tokio::select! {
                r = next.connect() => {
                    r?;
                    let connected = std::mem::replace(&mut next, server(&name, false)?);
                    let (link, active, last_used) = (link.clone(), active.clone(), last_used.clone());
                    active.fetch_add(1, Ordering::SeqCst);
                    tokio::spawn(async move {
                        handle(connected, link).await;
                        *last_used.lock().unwrap() = Instant::now();
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                _ = idle => {
                    if !persist && active.load(Ordering::SeqCst) == 0 && last_used.lock().unwrap().elapsed() > IDLE_EXIT {
                        log("idle; exiting");
                        let _ = std::fs::remove_file(wire::pipe_name_file());
                        return Ok::<_, anyhow::Error>(());
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conf_parses_like_the_linux_shim() {
        let c = parse_conf("# c\nhost = chris@chriss-imac\nkey=\"C:\\k\\blip\"\nhide_spam=on\n").unwrap();
        assert_eq!((c.user.as_str(), c.host.as_str(), c.port), ("chris", "chriss-imac", 22));
        assert_eq!(c.key, PathBuf::from("C:\\k\\blip"));
        assert!(c.hide_spam && !c.hide_unknown);
    }

    #[test]
    fn conf_refuses_option_shaped_hosts() {
        assert!(parse_conf("host=-oProxyCommand=x").is_err());
        assert!(parse_conf("host=me@-evil").is_err());
        assert!(parse_conf("host=a b").is_ok()); // whitespace is dropped, as in the shim: "ab"
        assert!(parse_conf("").is_err());
    }

    #[test]
    fn remote_command_quotes_and_injects_flags() {
        let c = Conf { hide_spam: true, ..Default::default() };
        let argv: Vec<String> = ["imsg", "--json", "thread", "it's"].iter().map(|s| s.to_string()).collect();
        assert_eq!(remote_command(&argv, &c), "imsg '--hide-spam' '--json' 'thread' 'it'\\''s'");
        let send: Vec<String> = ["imsg-send", "--to", "x"].iter().map(|s| s.to_string()).collect();
        assert_eq!(remote_command(&send, &c), "imsg-send '--to' 'x'");
        assert_eq!(remote_command(&["ping".to_string()], &c), "ping");
    }
}
