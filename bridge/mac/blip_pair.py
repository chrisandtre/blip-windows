"""blip_pair — pair a Blip client (Windows, later Linux) with this Mac by code.

The Mac shows a six-digit code; the person types it on the PC. Neither side
sends the code: both run SPAKE2 with it (python-spake2, vendored in
blip_spake2/), so a listener on the network learns nothing it could test
guesses against offline, and each connection is exactly one online guess.
Five wrong guesses and the listener closes.

What the two sides then swap, each message tagged with a key derived from
the SPAKE2 secret, so neither can be swapped in transit:
  PC  -> Mac   its public key (ed25519), its name, its Tailscale addresses
  Mac -> PC    ssh user, names this Mac answers to, its ssh HOST keys (the
               PC writes them to known_hosts, so nobody types "yes" to a
               fingerprint), bridge version

Wire: one TCP connection, one JSON object per line, lines capped at 16 KB.
  1  PC  {"blip": "pair", "v": 1, "a": <hex SPAKE2 msg A>}
  2  Mac {"b": <hex SPAKE2 msg B>}
  3  PC  {"hello": "<JSON text>", "tag": <hex HMAC(k_pc, that text)>}
  4  Mac {"ok": "<JSON text>", "tag": <hex HMAC(k_mac, that text)>}
     or  {"error": "wrong code" | "..."}
The signed parts travel as the exact text that was signed, so neither side
has to reproduce the other's JSON formatting to check a tag.

This module is platform-neutral so the protocol can be tested anywhere; the
Mac specifics (enrolling the key, host names) come in as callbacks.
"""
import hashlib
import hmac
import json
import re
import secrets
import socket
import time

from blip_spake2 import SPAKE2_B, SPAKEError

PROTOCOL = 1
PORT = 7447
ID_PC, ID_MAC = b"blip-pc", b"blip-mac"
MAX_LINE = 16 * 1024
MAX_TRIES = 5
PUBKEY_RE = re.compile(r"^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$")
NAME_RE = re.compile(r"^[A-Za-z0-9 ._()'-]{1,64}$")


def new_code():
    return "%06d" % secrets.randbelow(10 ** 6)


def show_code(code):
    return code[:3] + " " + code[3:]


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def subkey(k, label):
    return hmac.new(k, label, hashlib.sha256).digest()


def tag(key, text):
    return hmac.new(key, text.encode("utf-8"), hashlib.sha256).hexdigest()


def is_tailscale(ip):
    if ip.startswith("100."):
        try:
            second = int(ip.split(".")[1])
        except (IndexError, ValueError):
            return False
        return 64 <= second <= 127
    return ip.lower().startswith("fd7a:115c:a1e0:")


def valid_hello(h):
    if not isinstance(h, dict):
        return "hello is not an object"
    if not isinstance(h.get("pubkey"), str) or not PUBKEY_RE.match(h["pubkey"]):
        return "pubkey is not a plain ed25519 key"
    if not isinstance(h.get("name"), str) or not NAME_RE.match(h["name"]):
        return "name is missing or has odd characters"
    ts = h.get("tsips", [])
    if not isinstance(ts, list) or len(ts) > 4 or not all(isinstance(x, str) and is_tailscale(x) for x in ts):
        return "tsips must be Tailscale addresses"
    return ""


class Line:
    """Newline-delimited JSON over a socket, with a size cap and a deadline."""

    def __init__(self, sock, timeout):
        self.sock, self.buf = sock, b""
        sock.settimeout(timeout)

    def read(self):
        while b"\n" not in self.buf:
            if len(self.buf) > MAX_LINE:
                raise ValueError("line too long")
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        if len(line) > MAX_LINE:
            raise ValueError("line too long")
        obj = json.loads(line.decode("utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("not an object")
        return obj

    def write(self, obj):
        self.sock.sendall(canonical(obj) + b"\n")


def serve_one(conn, peer_ip, code, enroll, describe, timeout=30):
    """Run one pairing attempt on an accepted connection.
    Returns ("paired", hello) | ("wrong", None) | ("bad", reason)."""
    ln = Line(conn, timeout)
    try:
        first = ln.read()
        if first.get("blip") != "pair" or first.get("v") != PROTOCOL:
            ln.write({"error": "this Mac speaks Blip pairing v%d" % PROTOCOL})
            return "bad", "unknown protocol"
        spake = SPAKE2_B(code.encode(), idA=ID_PC, idB=ID_MAC)
        mb = spake.start()
        try:
            k = spake.finish(bytes.fromhex(str(first.get("a", ""))))
        except (SPAKEError, ValueError) as e:
            ln.write({"error": "bad pairing message"})
            return "bad", "spake: %s" % e
        ln.write({"b": mb.hex()})
        k_pc, k_mac = subkey(k, b"blip pair pc"), subkey(k, b"blip pair mac")
        msg = ln.read()
        raw = msg.get("hello")
        if not isinstance(raw, str) or not hmac.compare_digest(str(msg.get("tag", "")), tag(k_pc, raw)):
            # The only way the tag fails is a different code on the PC.
            ln.write({"error": "wrong code"})
            return "wrong", None
        try:
            hello = json.loads(raw)
        except ValueError:
            hello = None
        why = valid_hello(hello)
        if why:
            ln.write({"error": why})
            return "bad", why
        why = enroll(hello, peer_ip)
        if why:
            ln.write({"error": why})
            return "bad", why
        ok = canonical(describe()).decode()
        ln.write({"ok": ok, "tag": tag(k_mac, ok)})
        return "paired", hello
    except (ValueError, ConnectionError, socket.timeout, OSError) as e:
        return "bad", str(e) or type(e).__name__


def listen(code, enroll, describe, port=PORT, deadline_s=600, on_event=None, bind=""):
    """Accept connections until one pairs, MAX_TRIES wrong codes, or the
    deadline. Returns the paired hello, or None."""
    on_event = on_event or (lambda *a: None)
    srv = None
    for fam, addr in ((socket.AF_INET6, (bind or "::", port)), (socket.AF_INET, (bind or "0.0.0.0", port))):
        try:
            srv = socket.socket(fam, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if fam == socket.AF_INET6:
                srv.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            srv.bind(addr)
            break
        except OSError:
            srv.close()
            srv = None
    if srv is None:
        raise OSError("port %d is busy" % port)
    srv.listen(4)
    end = time.monotonic() + deadline_s
    wrong = 0
    try:
        while True:
            left = end - time.monotonic()
            if left <= 0:
                on_event("expired")
                return None
            srv.settimeout(min(left, 1.0))
            try:
                conn, addr = srv.accept()
            except socket.timeout:
                continue
            peer = addr[0]
            if peer.startswith("::ffff:"):
                peer = peer[7:]
            with conn:
                result, detail = serve_one(conn, peer, code, enroll, describe)
            if result == "paired":
                on_event("paired", detail)
                return detail
            if result == "wrong":
                wrong += 1
                on_event("wrong", MAX_TRIES - wrong)
                if wrong >= MAX_TRIES:
                    on_event("locked")
                    return None
            else:
                on_event("bad", detail)
    finally:
        srv.close()


def lan_pattern(ip):
    """The /24 around a private IPv4 address, for from= pinning; else ""."""
    parts = ip.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        return ""
    a, b = int(parts[0]), int(parts[1])
    private = a == 10 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168)
    return "%s.%s.%s.0/24" % tuple(parts[:3]) if private else ""


def from_patterns(peer_ip, tsips):
    """Where this key may connect from: the PC's Tailscale addresses (stable
    per device) plus the local network it paired from. Empty means unpinned,
    which only happens when neither is known."""
    pats = [ip for ip in tsips if is_tailscale(ip)]
    if is_tailscale(peer_ip) and peer_ip not in pats:
        pats.append(peer_ip)
    lan = lan_pattern(peer_ip)
    if lan:
        pats.append(lan)
    return pats


def authorized_line(pubkey, name, patterns):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    opt = ('from="%s",' % ",".join(patterns)) if patterns else ""
    return '%srestrict,command="$HOME/.blip/bin/blip-dispatch" %s blip:%s' % (opt, pubkey, safe)


def replace_in_authorized_keys(text, pubkey, line):
    """Drop any line holding this key (a re-pair replaces it), append line."""
    body = pubkey.split()[1]
    kept = [l for l in text.splitlines() if body not in l]
    return "\n".join(kept + [line]) + "\n"
