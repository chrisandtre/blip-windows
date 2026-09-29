//! Pairing with a Mac by code: the PC half of bridge/mac/blip_pair.py.
//!
//! The Mac runs `blip pair`, shows six digits and advertises itself over
//! Bonjour as `_blip-pair._tcp`. Here we find it, run SPAKE2 with the code
//! (the code itself never crosses the network), send this PC's public key,
//! and get back the Mac's ssh user, names and HOST keys. The host keys go
//! straight into known_hosts, so nobody types "yes" to a fingerprint, and the
//! Mac confines our key to blip-dispatch exactly as the password setup does.

use std::path::{Path, PathBuf};
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Sha256;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

const SERVICE: &str = "_blip-pair._tcp.local.";
pub const PORT: u16 = 7447;
const MAX_LINE: usize = 16 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct FoundMac {
    pub name: String,
    pub addrs: Vec<String>,
    pub port: u16,
    pub user: String,
}

#[derive(Serialize, Debug)]
pub struct Paired {
    pub host: String,
    pub computer: String,
    pub bridge: String,
}

/// Browse Bonjour for Macs running `blip pair`, for up to `secs`.
pub async fn discover(secs: u64) -> Result<Vec<FoundMac>, String> {
    tokio::task::spawn_blocking(move || {
        let mdns = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
        let rx = mdns.browse(SERVICE).map_err(|e| e.to_string())?;
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        let mut found: Vec<FoundMac> = Vec::new();
        while let Some(left) = end.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                    let name = info.get_fullname().trim_end_matches(SERVICE).trim_end_matches('.').replace("\\032", " ");
                    let mut addrs: Vec<String> = info.get_addresses().iter().map(|a| a.to_string()).collect();
                    addrs.sort_by_key(|a| (a.contains(':'), a.clone())); // IPv4 first
                    let user = info.get_property_val_str("user").unwrap_or_default().to_string();
                    if let Some(m) = found.iter_mut().find(|m| m.name == name) {
                        for a in addrs {
                            if !m.addrs.contains(&a) {
                                m.addrs.push(a);
                            }
                        }
                    } else {
                        found.push(FoundMac { name, addrs, port: info.get_port(), user });
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = mdns.shutdown();
        Ok(found)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn tag(key: &[u8], text: &str) -> String {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    m.update(text.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

fn subkey(k: &[u8], label: &[u8]) -> Vec<u8> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(k).expect("any key length");
    m.update(label);
    m.finalize().into_bytes().to_vec()
}

struct Wire {
    r: BufReader<tokio::net::tcp::OwnedReadHalf>,
    w: tokio::net::tcp::OwnedWriteHalf,
}

impl Wire {
    async fn read(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        let n = tokio::time::timeout(Duration::from_secs(30), (&mut self.r).take(MAX_LINE as u64 + 1).read_line(&mut line))
            .await
            .map_err(|_| "the Mac stopped answering".to_string())?
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the Mac closed the connection".into());
        }
        if line.len() > MAX_LINE {
            return Err("the Mac sent too much".into());
        }
        let v: Value = serde_json::from_str(&line).map_err(|_| "the Mac sent something unreadable".to_string())?;
        if let Some(e) = v.get("error").and_then(Value::as_str) {
            return Err(match e {
                "wrong code" => "That code didn't match. Check the code on the Mac and try again.".into(),
                other => format!("The Mac said: {other}"),
            });
        }
        Ok(v)
    }

    async fn write(&mut self, v: &Value) -> Result<(), String> {
        let mut s = serde_json::to_string(v).map_err(|e| e.to_string())?;
        s.push('\n');
        self.w.write_all(s.as_bytes()).await.map_err(|e| e.to_string())
    }
}

use tokio::io::AsyncReadExt as _;

fn user_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn hostname_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 253 && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
}

fn host_key_ok(s: &str) -> bool {
    let mut p = s.split(' ');
    matches!((p.next(), p.next(), p.next()), (Some(t), Some(k), None)
        if ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"].contains(&t)
        && !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)))
}

/// Pair with the Mac at `addr` (an address or a name) using `code`.
pub async fn pair(addr: &str, port: u16, code: &str, key: &Path, tsips: Vec<String>, known_hosts: &Path) -> Result<Paired, String> {
    let code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if code.len() != 6 {
        return Err("The code is six digits.".into());
    }
    let pubkey = public_key(key).await?;
    let target = if addr.contains(':') && !addr.starts_with('[') { format!("[{addr}]:{port}") } else { format!("{addr}:{port}") };
    let sock = tokio::time::timeout(Duration::from_secs(8), TcpStream::connect(&target))
        .await
        .map_err(|_| format!("Couldn't reach {addr}. Is `blip pair` still running on the Mac?"))?
        .map_err(|_| format!("Couldn't reach {addr}. Is `blip pair` still running on the Mac?"))?;
    let (r, w) = sock.into_split();
    let mut wire = Wire { r: BufReader::new(r), w };

    let (spake, msg_a) = Spake2::<Ed25519Group>::start_a(&Password::new(code.as_bytes()), &Identity::new(b"blip-pc"), &Identity::new(b"blip-mac"));
    wire.write(&json!({"blip": "pair", "v": 1, "a": hex::encode(&msg_a)})).await?;
    let b = wire.read().await?;
    let msg_b = hex::decode(b.get("b").and_then(Value::as_str).unwrap_or_default()).map_err(|_| "bad reply from the Mac")?;
    let k = spake.finish(&msg_b).map_err(|_| "the pairing handshake failed")?;
    let (k_pc, k_mac) = (subkey(&k, b"blip pair pc"), subkey(&k, b"blip pair mac"));

    let name: String = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".into()).chars().filter(|c| c.is_ascii_alphanumeric() || " ._-".contains(*c)).take(64).collect();
    let hello = json!({"name": if name.is_empty() { "Windows PC".to_string() } else { name }, "pubkey": pubkey, "tsips": tsips}).to_string();
    wire.write(&json!({"hello": hello, "tag": tag(&k_pc, &hello)})).await?;
    let reply = wire.read().await?;
    let ok_raw = reply.get("ok").and_then(Value::as_str).ok_or("bad reply from the Mac")?;
    if reply.get("tag").and_then(Value::as_str) != Some(tag(&k_mac, ok_raw).as_str()) {
        return Err("The Mac's reply didn't check out; nothing was changed on this PC.".into());
    }
    let ok: Value = serde_json::from_str(ok_raw).map_err(|_| "bad reply from the Mac")?;

    let user = ok["user"].as_str().unwrap_or_default().to_string();
    let names: Vec<String> = ok["names"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|n| hostname_ok(n)).map(String::from).collect();
    let keys: Vec<String> = ok["host_keys"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|k| host_key_ok(k)).map(String::from).collect();
    if !user_ok(&user) || names.is_empty() || keys.is_empty() {
        return Err("The Mac's reply was missing its name or keys.".into());
    }
    let port = ok["port"].as_u64().filter(|p| *p > 0 && *p < 65536).unwrap_or(22) as u16;
    write_known_hosts(known_hosts, &names, port, &keys)?;
    Ok(Paired {
        host: format!("{user}@{}", names[0]),
        computer: ok["computer"].as_str().unwrap_or(&names[0]).to_string(),
        bridge: ok["bridge"].as_str().unwrap_or("?").to_string(),
    })
}

async fn public_key(key: &Path) -> Result<String, String> {
    if !key.exists() {
        let system = std::env::var_os("SystemRoot").map(PathBuf::from).ok_or("SystemRoot is not set")?;
        let keygen = system.join("System32").join("OpenSSH").join("ssh-keygen.exe");
        if !keygen.exists() {
            return Err("The Windows OpenSSH client is missing (Settings > System > Optional features > OpenSSH Client).".into());
        }
        if let Some(dir) = key.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let comment = format!("blip@{}", std::env::var("COMPUTERNAME").unwrap_or_default());
        let st = tokio::process::Command::new(keygen)
            .args(["-q", "-t", "ed25519", "-N", "", "-C", &comment, "-f"])
            .arg(key)
            .creation_flags(0x0800_0000)
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if !st.success() {
            return Err("ssh-keygen could not create this PC's key".into());
        }
    }
    let text = std::fs::read_to_string(key.with_extension("pub").as_path()).or_else(|_| std::fs::read_to_string(format!("{}.pub", key.display()))).map_err(|e| e.to_string())?;
    let mut p = text.split_whitespace();
    match (p.next(), p.next()) {
        (Some("ssh-ed25519"), Some(k)) => Ok(format!("ssh-ed25519 {k}")),
        _ => Err("this PC's Blip key is not ed25519".into()),
    }
}

pub fn known_hosts_path() -> PathBuf {
    blip_wire::profile_dir("USERPROFILE").join(".ssh").join("known_hosts")
}

/// Replace every known_hosts line for these names with the Mac's keys.
fn write_known_hosts(path: &Path, names: &[String], port: u16, keys: &[String]) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let host = |n: &String| if port == 22 { n.to_ascii_lowercase() } else { format!("[{}]:{port}", n.to_ascii_lowercase()) };
    let ours: Vec<String> = names.iter().map(host).collect();
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut out: Vec<String> = text
        .lines()
        .filter(|l| {
            let first = l.split_whitespace().next().unwrap_or("");
            !first.split(',').any(|h| ours.iter().any(|o| o.eq_ignore_ascii_case(h)))
        })
        .map(String::from)
        .collect();
    for k in keys {
        out.push(format!("{} {k}", ours.join(",")));
    }
    std::fs::write(path, out.join("\n") + "\n").map_err(|e| e.to_string())
}

/// This PC's Tailscale addresses, if Tailscale is installed and up.
pub async fn tailscale_ips() -> Vec<String> {
    let mut exes = vec![PathBuf::from("tailscale.exe")];
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        exes.insert(0, PathBuf::from(pf).join("Tailscale").join("tailscale.exe"));
    }
    for exe in exes {
        if let Ok(Ok(out)) = tokio::time::timeout(
            Duration::from_secs(4),
            tokio::process::Command::new(&exe).arg("ip").creation_flags(0x0800_0000).output(),
        )
        .await
        {
            if out.status.success() {
                return String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|l| l.parse::<std::net::IpAddr>().is_ok())
                    .map(String::from)
                    .collect();
            }
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the real Mac half: run
    ///   python bridge/mac/test_blip_pair.py serve 48291 482913
    /// then  BLIP_PAIR_PORT=48291 cargo test -p blip-app -- --ignored pairs_with
    #[tokio::test]
    #[ignore]
    async fn pairs_with_the_python_listener() {
        let port: u16 = std::env::var("BLIP_PAIR_PORT").expect("BLIP_PAIR_PORT").parse().unwrap();
        let dir = std::env::temp_dir().join(format!("blip-pair-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let kh = dir.join("known_hosts");
        std::fs::write(&kh, "other ssh-ed25519 AAAAkeep\nmac ssh-ed25519 AAAAold\n").unwrap();
        let wrong = pair("127.0.0.1", port, "000 000", &dir.join("k"), vec![], &kh).await;
        assert!(wrong.unwrap_err().contains("didn't match"));
        let p = pair("127.0.0.1", port, "482 913", &dir.join("k"), vec!["100.96.115.78".into()], &kh).await.unwrap();
        assert_eq!(p.host, "chris@mac");
        let text = std::fs::read_to_string(&kh).unwrap();
        assert!(text.contains("other ssh-ed25519 AAAAkeep"), "{text}");
        assert!(!text.contains("AAAAold"), "{text}");
        assert!(text.contains("mac,mac.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_key_shapes() {
        assert!(host_key_ok("ssh-ed25519 AAAAC3Nza+/="));
        assert!(!host_key_ok("ssh-ed25519 AAAA extra"));
        assert!(!host_key_ok("ssh-dss AAAA"));
        assert!(hostname_ok("chriss-imac.local"));
        assert!(!hostname_ok("-oProxyCommand=x"));
        assert!(user_ok("chris") && !user_ok("-x") && !user_ok("a b"));
    }
}
