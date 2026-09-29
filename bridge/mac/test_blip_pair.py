#!/usr/bin/env python3
"""Pairing protocol: the right code pairs, a wrong one never does and never
enrolls, five wrong codes close the listener, and a tampered hello is
refused. Runs on any OS (the Mac specifics are callbacks)."""
import json
import os
import socket
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blip_pair as bp  # noqa: E402
from blip_spake2 import SPAKE2_A  # noqa: E402

PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB9gQ0yIq8m3JX0e3oRz1nW5nZ9b8o3o1Vv6q0x2yZ5a"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def client(port, code, hello=None, tamper=False):
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    ln = bp.Line(sock, 10)
    a = SPAKE2_A(code.encode(), idA=bp.ID_PC, idB=bp.ID_MAC)
    ln.write({"blip": "pair", "v": 1, "a": a.start().hex()})
    b = ln.read()
    if "error" in b:
        return b
    k = a.finish(bytes.fromhex(b["b"]))
    k_pc, k_mac = bp.subkey(k, b"blip pair pc"), bp.subkey(k, b"blip pair mac")
    hello = json.dumps(hello or {"name": "TESTPC", "pubkey": PUB, "tsips": ["100.96.115.78"]})
    t = bp.tag(k_pc, hello)
    if tamper:
        hello = hello.replace("TESTPC", "EVIL")
    ln.write({"hello": hello, "tag": t})
    r = ln.read()
    sock.close()
    if "ok" in r:
        r["verified"] = r["tag"] == bp.tag(k_mac, r["ok"])
        r["ok"] = json.loads(r["ok"])
    return r


class PairTest(unittest.TestCase):
    def run_server(self, code, **kw):
        self.enrolled, self.events, self.port = [], [], free_port()
        self.result = {}

        def enroll(hello, peer):
            self.enrolled.append((hello, peer))
            return ""

        def describe():
            return {"user": "chris", "names": ["mac"], "host_keys": ["ssh-ed25519 AAAA"], "bridge": "t"}

        def go():
            self.result["hello"] = bp.listen(code, enroll, describe, port=self.port, deadline_s=kw.get("deadline", 20),
                                             on_event=lambda *e: self.events.append(e), bind="127.0.0.1")
        th = threading.Thread(target=go, daemon=True)
        th.start()
        import time
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        # that probe connection counts as a "bad" attempt, not a guess
        return th

    def test_right_code_pairs_and_verifies(self):
        th = self.run_server("482913")
        r = client(self.port, "482913")
        th.join(5)
        self.assertTrue(r.get("verified"), r)
        self.assertEqual(self.result["hello"]["name"], "TESTPC")
        self.assertEqual(len(self.enrolled), 1)
        self.assertEqual(self.enrolled[0][1], "127.0.0.1")

    def test_wrong_code_never_enrolls_and_locks_after_five(self):
        th = self.run_server("482913")
        for i in range(bp.MAX_TRIES):
            self.assertEqual(client(self.port, "000000"), {"error": "wrong code"})
        th.join(5)
        self.assertIsNone(self.result["hello"])
        self.assertEqual(self.enrolled, [])
        self.assertIn(("locked",), self.events)

    def test_tampered_hello_is_a_wrong_code(self):
        th = self.run_server("111222")
        self.assertEqual(client(self.port, "111222", tamper=True), {"error": "wrong code"})
        self.assertEqual(self.enrolled, [])
        client(self.port, "111222")
        th.join(5)

    def test_bad_pubkey_refused(self):
        th = self.run_server("333444")
        r = client(self.port, "333444", hello={"name": "PC", "pubkey": "ssh-rsa AAAA", "tsips": []})
        self.assertIn("error", r)
        self.assertEqual(self.enrolled, [])
        client(self.port, "333444")
        th.join(5)


class HelpersTest(unittest.TestCase):
    def test_from_patterns(self):
        self.assertEqual(bp.from_patterns("192.168.1.50", ["100.96.115.78"]), ["100.96.115.78", "192.168.1.0/24"])
        self.assertEqual(bp.from_patterns("100.96.115.78", []), ["100.96.115.78"])
        self.assertEqual(bp.from_patterns("8.8.8.8", []), [])

    def test_authorized_line_and_replace(self):
        line = bp.authorized_line(PUB, "CHRIS LENOVO", ["100.96.115.78"])
        self.assertTrue(line.startswith('from="100.96.115.78",restrict,command="$HOME/.blip/bin/blip-dispatch" '))
        self.assertTrue(line.endswith(" blip:CHRIS_LENOVO"))
        text = "ssh-ed25519 OTHER me\n" + PUB + " old\n"
        new = bp.replace_in_authorized_keys(text, PUB, line)
        self.assertEqual(new, "ssh-ed25519 OTHER me\n" + line + "\n")

    def test_code_shape(self):
        c = bp.new_code()
        self.assertRegex(c, r"^\d{6}$")
        self.assertEqual(bp.show_code("482913"), "482 913")


def serve(port, code):
    """For the Rust client's integration test: pair once, fake Mac answers."""
    def describe():
        return {"user": "chris", "computer": "Test Mac", "names": ["mac", "mac.local"], "port": 22,
                "host_keys": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest"], "bridge": "test"}
    hello = bp.listen(code, lambda h, peer: "", describe, port=port, deadline_s=120, bind="127.0.0.1",
                      on_event=lambda *e: print("event", *e, flush=True))
    print("paired", json.dumps(hello), flush=True)


if __name__ == "__main__":
    if sys.argv[1:2] == ["serve"]:
        serve(int(sys.argv[2]), sys.argv[3])
    else:
        unittest.main()
