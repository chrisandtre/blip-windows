// A stand-in for the Tauri runtime in a plain browser (mock mode, see
// serve.ts). core/shim/setup_state go to the mock bridge; everything else is
// a harmless no-op. Only loaded by a dev build when Tauri is absent.
type Args = Record<string, unknown>;
let nextId = 1;
const callbacks = new Map<number, (x: unknown) => void>();

async function bridge(cmd: string, args: Args) {
  const r = await fetch("http://127.0.0.1:1421/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, args }) });
  return r.json();
}

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  transformCallback(cb: (x: unknown) => void) {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
  },
  convertFileSrc(path: string) {
    return "http://127.0.0.1:1421/file?p=" + encodeURIComponent(path);
  },
  async invoke(cmd: string, args: Args = {}) {
    // ?setup shows the first-run pairing screen with a fake Mac; 482913 pairs.
    if (location.search.includes("setup")) {
      if (cmd === "setup_state") return { ...(await bridge(cmd, args)), configured: false };
      if (cmd === "discover_macs") {
        await new Promise((r) => setTimeout(r, 1500));
        return [{ name: "Chris’s iMac", addrs: ["192.168.1.109", "100.85.192.43"], port: 7447, user: "chris" }];
      }
      if (cmd === "pair_mac") {
        await new Promise((r) => setTimeout(r, 1200));
        if (args.code !== "482913") throw "That code didn't match. Check the code on the Mac and try again.";
        return { host: "chris@chriss-imac", computer: "Chris’s iMac", bridge: "0.3.0" };
      }
    }
    if (cmd === "core" || cmd === "shim" || cmd === "setup_state") return bridge(cmd, args);
    if (cmd === "plugin:event|listen") return nextId++;
    if (cmd === "plugin:notification|is_permission_granted") return true;
    if (cmd === "plugin:notification|notify") { console.log("[mock] notification", args); return null; }
    return null;
  },
};
console.log("[mock] Tauri stand-in active: reads are real, sends are fake");

export {};
