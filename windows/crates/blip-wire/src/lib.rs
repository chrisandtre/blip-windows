//! What blip-shim and blip-mux agree on: where things live, the tool list, how
//! arguments are quoted for the Mac, and the bytes on the named pipe.
//!
//! std only, so the shim stays small.
//!
//! Request (shim -> mux), once:
//!   u32 argc, then per arg: u32 len + UTF-8 bytes   (argv[0] is the tool)
//!   u64 stdin_len + stdin bytes
//! Response (mux -> shim), repeated frames:
//!   u8 kind + u32 len + payload
//!   kind 1 stdout, 2 stderr, 3 exit (payload: i32 LE), always last
//!
//! All integers little-endian.

use std::io::{self, Read, Write};
use std::path::PathBuf;

pub const FRAME_STDOUT: u8 = 1;
pub const FRAME_STDERR: u8 = 2;
pub const FRAME_EXIT: u8 = 3;

/// EX_UNAVAILABLE: the Mac is unreachable. Blip greys out on this code.
pub const EXIT_OFFLINE: i32 = 69;
/// EX_USAGE: not a Blip tool.
pub const EXIT_USAGE: i32 = 64;
/// EX_CONFIG: no or bad bridge.conf.
pub const EXIT_CONFIG: i32 = 78;

/// The tools blip-dispatch runs, plus its "ping" probe. Same list as
/// bridge/mac/blip-dispatch; anything else is refused before it leaves this PC.
pub const TOOLS: &[&str] = &["imsg", "imsg-send", "imsg-read", "contacts", "contact-save", "blip-check"];

pub fn is_tool(name: &str) -> bool {
    name == "ping" || TOOLS.contains(&name)
}

/// Upper bounds, so a confused or hostile client cannot make the mux allocate
/// without limit. 64 MiB of stdin covers any file Messages will send.
pub const MAX_ARGS: u32 = 256;
pub const MAX_ARG_LEN: u32 = 64 * 1024;
pub const MAX_STDIN: u64 = 64 * 1024 * 1024;

/// %LOCALAPPDATA%\Blip — Blip's Windows home. The app runs the TypeScript
/// core with HOME set here, so the core's own ~/.config/blip, ~/.cache/blip,
/// ~/.local/state/blip and ~/bin (the shims) all land inside it unchanged.
/// The mux's pipe name, lock and log live here too. Not roaming: the key and
/// known_hosts it depends on are per machine.
pub fn local_dir() -> PathBuf {
    profile_dir("LOCALAPPDATA").join("Blip")
}

/// An absolute profile folder from the environment, or a hard stop. An empty
/// or relative value must never turn into a path under the current directory,
/// which could then supply known_hosts or bridge.conf.
pub fn profile_dir(var: &str) -> PathBuf {
    match std::env::var_os(var).map(PathBuf::from) {
        Some(p) if p.is_absolute() => p,
        _ => {
            eprintln!("blip: %{var}% is not set to an absolute path; refusing to guess");
            std::process::exit(EXIT_CONFIG);
        }
    }
}

/// ~/.config/blip under Blip's Windows home — where the core looks for bridge.conf.
pub fn config_dir() -> PathBuf {
    local_dir().join(".config").join("blip")
}

/// bridge.conf, or BLIP_BRIDGE_CONF when set (tests, a second profile).
pub fn conf_path() -> PathBuf {
    match std::env::var_os("BLIP_BRIDGE_CONF") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => config_dir().join("bridge.conf"),
    }
}

/// The file holding the running mux's pipe name. The name is random per run
/// and this file sits in the user's own profile, so another account on the PC
/// can neither guess the pipe nor squat it before the mux starts.
pub fn pipe_name_file() -> PathBuf {
    local_dir().join("mux.pipe")
}

/// Quote one argument the way bash's `${x@Q}` does for the Linux shim:
/// blip-dispatch shlex-splits the command, so POSIX single quotes round-trip
/// spaces, apostrophes and leading dashes exactly.
pub fn sh_quote(arg: &str) -> String {
    let mut s = String::with_capacity(arg.len() + 2);
    s.push('\'');
    for c in arg.chars() {
        if c == '\'' {
            s.push_str("'\\''");
        } else {
            s.push(c);
        }
    }
    s.push('\'');
    s
}

pub fn write_request<W: Write>(w: &mut W, argv: &[String], stdin: &[u8]) -> io::Result<()> {
    let mut buf = Vec::with_capacity(16 + stdin.len() + argv.iter().map(|a| a.len() + 4).sum::<usize>());
    buf.extend_from_slice(&(argv.len() as u32).to_le_bytes());
    for a in argv {
        buf.extend_from_slice(&(a.len() as u32).to_le_bytes());
        buf.extend_from_slice(a.as_bytes());
    }
    buf.extend_from_slice(&(stdin.len() as u64).to_le_bytes());
    buf.extend_from_slice(stdin);
    w.write_all(&buf)?;
    w.flush()
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

pub fn read_request<R: Read>(r: &mut R) -> io::Result<(Vec<String>, Vec<u8>)> {
    let mut u32b = [0u8; 4];
    r.read_exact(&mut u32b)?;
    let argc = u32::from_le_bytes(u32b);
    if argc == 0 || argc > MAX_ARGS {
        return Err(bad("argc out of range"));
    }
    let mut argv = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        r.read_exact(&mut u32b)?;
        let n = u32::from_le_bytes(u32b);
        if n > MAX_ARG_LEN {
            return Err(bad("argument too long"));
        }
        let mut a = vec![0u8; n as usize];
        r.read_exact(&mut a)?;
        argv.push(String::from_utf8(a).map_err(|_| bad("argument is not UTF-8"))?);
    }
    let mut u64b = [0u8; 8];
    r.read_exact(&mut u64b)?;
    let n = u64::from_le_bytes(u64b);
    if n > MAX_STDIN {
        return Err(bad("stdin too large"));
    }
    let mut stdin = vec![0u8; n as usize];
    r.read_exact(&mut stdin)?;
    Ok((argv, stdin))
}

pub fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(5 + payload.len());
    f.push(kind);
    f.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    f.extend_from_slice(payload);
    f
}

/// One response frame, or None at a clean end of stream.
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
    if n > 16 * 1024 * 1024 {
        return Err(bad("frame too large"));
    }
    let mut p = vec![0u8; n as usize];
    r.read_exact(&mut p)?;
    Ok(Some((head[0], p)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_matches_bash_at_q() {
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("--to"), "'--to'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("a b;$(x)"), "'a b;$(x)'");
    }

    #[test]
    fn request_round_trips() {
        let argv = vec!["imsg-send".to_string(), "--to".into(), "+1 555 'x'".into()];
        let mut buf = Vec::new();
        write_request(&mut buf, &argv, b"hello\0bytes").unwrap();
        let (a, s) = read_request(&mut buf.as_slice()).unwrap();
        assert_eq!(a, argv);
        assert_eq!(s, b"hello\0bytes");
    }

    #[test]
    fn frames_round_trip_and_end_cleanly() {
        let mut buf = frame(FRAME_STDOUT, b"out");
        buf.extend(frame(FRAME_EXIT, &7i32.to_le_bytes()));
        let mut r = buf.as_slice();
        assert_eq!(read_frame(&mut r).unwrap(), Some((FRAME_STDOUT, b"out".to_vec())));
        assert_eq!(read_frame(&mut r).unwrap(), Some((FRAME_EXIT, 7i32.to_le_bytes().to_vec())));
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn refuses_oversized_requests() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_ARGS + 1).to_le_bytes());
        assert!(read_request(&mut buf.as_slice()).is_err());
    }

    #[test]
    fn tool_list_matches_dispatch() {
        assert!(is_tool("imsg") && is_tool("ping") && is_tool("blip-check"));
        assert!(!is_tool("tcc-check") && !is_tool("sh") && !is_tool("../imsg"));
    }
}
