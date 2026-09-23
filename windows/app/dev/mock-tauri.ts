// A stand-in for the Tauri runtime in a plain browser (mock mode, see
// serve.ts). core/shim/setup_state go to the mock bridge; everything else is
// a harmless no-op. Only loaded by a dev build when Tauri is absent.
type Args = Record<string, unknown>;
let nextId = 1;
const callbacks = new Map<number, (x: unknown) => void>();

async function bridge(cmd: string, args: Args) {
  const r = await fetch("http://localhost:1421/", { method: "POST", body: JSON.stringify({ cmd, args }) });
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
    return "http://localhost:1421/file?p=" + encodeURIComponent(path);
  },
  async invoke(cmd: string, args: Args = {}) {
    if (cmd === "core" || cmd === "shim" || cmd === "setup_state") return bridge(cmd, args);
    if (cmd === "plugin:event|listen") return nextId++;
    if (cmd === "plugin:notification|is_permission_granted") return true;
    if (cmd === "plugin:notification|notify") { console.log("[mock] notification", args); return null; }
    return null;
  },
};
console.log("[mock] Tauri stand-in active: reads are real, sends are fake");

export {};
