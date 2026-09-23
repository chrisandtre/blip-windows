// Mock mode: the real Blip UI in a plain browser, for testing without the
// Tauri shell and WITHOUT SENDING ANYTHING.
//
//   bun windows/app/dev/serve.ts        then open http://localhost:1420
//
// Reads are real: core scripts run against the configured Mac exactly as the
// app runs them (HOME = %LOCALAPPDATA%\Blip). Sends are fake: imsg-send and
// send-file never reach the Mac; they wait a second and report success, or
// failure when the text starts with "FAIL". Dev builds only; nothing here ships.
import { join, resolve } from "node:path";

const app = resolve(import.meta.dir, "..");
const repo = resolve(app, "..", "..");
const home = join(process.env.LOCALAPPDATA!, "Blip");
const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: join(home, "run") };
delete env.XDG_CACHE_HOME;
delete env.XDG_CONFIG_HOME;

const SCRIPTS = new Set(["collector", "thread", "fetch", "avatar", "search", "linkpreview", "contact-search"]);
const READ_TOOLS = new Set(["imsg", "contacts"]);

async function run(cmd: string[], stdin: string | null) {
  const p = Bun.spawn(cmd, { cwd: repo, env, stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

async function fakeSend(what: string, stdin: string | null) {
  await Bun.sleep(1000);
  const fail = (stdin || "").trimStart().startsWith("FAIL");
  console.log(`[mock] FAKE ${what}: ${fail ? "failed" : "ok"} (${(stdin || "").length} chars on stdin, nothing sent)`);
  return fail ? { code: 1, stdout: "", stderr: "simulated failure" } : { code: 0, stdout: what === "send-file" ? JSON.stringify({ ok: true, online: true, error: "" }) : "", stderr: "" };
}

// This bridge serves real messages, so only this machine's mock page may use
// it: loopback only, the page's Origin, and a JSON content type (which forces
// a browser preflight, so another site cannot even fire a request blind).
const ORIGIN = "http://localhost:1420";
Bun.serve({
  hostname: "127.0.0.1",
  port: 1421,
  async fetch(req) {
    const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "content-type" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const img = req.method === "GET" && url.pathname === "/file";
    if (!img && (req.headers.get("origin") !== ORIGIN || !String(req.headers.get("content-type")).startsWith("application/json")))
      return new Response("no", { status: 403 });
    if (url.pathname === "/file") {
      // Cached images for the page (what the asset protocol serves in the app):
      // only files under Blip's cache.
      const p = resolve(url.searchParams.get("p") || "");
      const cache = resolve(home, ".cache");
      if (!p.toLowerCase().startsWith(cache.toLowerCase() + "\\")) return new Response("no", { status: 403 });
      return new Response(Bun.file(p));
    }
    const { cmd, args } = (await req.json()) as { cmd: string; args: Record<string, unknown> };
    let body: unknown = null;
    if (cmd === "core") {
      const script = String(args.script);
      if (script === "send-file") body = await fakeSend("send-file", (args.stdin as string) ?? null);
      // contact-save: prepare/preview never leave this machine; save is faked.
      else if (script === "contact-save" && (args.args as string[])[0] === "save") {
        await Bun.sleep(800);
        console.log("[mock] FAKE contact save (nothing written on the Mac)");
        const d = JSON.parse(String(args.stdin || "{}"));
        body = { code: 0, stdout: JSON.stringify({ ok: true, name: [d.firstName, d.lastName].filter(Boolean).join(" ") }), stderr: "" };
      } else if (script === "contact-save") body = await run(["bun", "contact-save.ts", ...(args.args as string[])], (args.stdin as string) ?? null);
      else if (!SCRIPTS.has(script)) body = { code: 64, stdout: "", stderr: `mock: '${script}' not allowed` };
      else body = await run(["bun", `${script}.ts`, ...(args.args as string[])], (args.stdin as string) ?? null);
    } else if (cmd === "shim") {
      const tool = String(args.tool);
      if (tool === "imsg-send") body = await fakeSend("imsg-send", (args.stdin as string) ?? null);
      else if (!READ_TOOLS.has(tool)) body = { code: 64, stdout: "", stderr: `mock: '${tool}' not allowed` };
      else body = await run([join(home, "bin", `${tool}.exe`), ...(args.args as string[])], (args.stdin as string) ?? null);
    } else if (cmd === "setup_state") {
      body = { configured: true, host: "mock", shims: true };
    }
    return Response.json(body, { headers: cors });
  },
});
console.log("[mock] bridge on :1421 - reads are real, sends are fake");

const vite = Bun.spawn(["bunx", "vite", "--port", "1420", "--strictPort"], { cwd: app, stdout: "inherit", stderr: "inherit", env: { ...process.env, VITE_BLIP_MOCK: "1" } });
process.on("SIGINT", () => { vite.kill(); process.exit(0); });
await vite.exited;
