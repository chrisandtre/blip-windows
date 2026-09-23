import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { register } from "@tauri-apps/plugin-global-shortcut";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { Toast } from "./bridge";
import { Poller } from "./poller";
import { View } from "./view";
import "./style.css";

// Mock mode (windows/app/dev/serve.ts): a plain browser with real reads and
// fake sends. The condition is a build-time constant, so a release drops it.
if (import.meta.env.VITE_BLIP_MOCK && !("__TAURI_INTERNALS__" in window)) await import("../dev/mock-tauri");

let view!: View;
const poller = new Poller(
  {
    activeReadChat: () => view.activeReadChat(),
    activeSeenTs: () => view.activeSeenTs(),
    surfaceOpen: () => view.surfaceOpen(),
    pushReload: () => view.pushReload(),
  },
  {
    threads: (list) => view.setThreads(list),
    status: (s) => {
      view.setStatus(s);
      void invoke("set_status", { unread: s.unread, online: s.online });
    },
    toasts: (list) => void toast(list),
    code: (c) => {
      view.showCode(c);
      void notify("Security code", `From ${c.name || "a sender"}${c.domain ? " for " + c.domain : ""}. Open Blip to copy it.`);
    },
  },
);
view = new View(poller);

// ---- notifications. The collector already applied the allowlist, the
// mute list and the "not while you're reading it" gate; the body is capped
// the way BarWidget caps it (220 chars).
// Toasts go through the shell's own `toast` command so a click can open the
// conversation; the plugin is the fallback (and mock mode's path).
let allowed: boolean | null = null;
async function notify(title: string, body: string, chat = "") {
  const text = body.length > 220 ? body.slice(0, 217) + "…" : body;
  try {
    await invoke("toast", { title, body: text, chat });
    return;
  } catch { /* fall back to the plugin */ }
  if (allowed === null) {
    allowed = await isPermissionGranted();
    if (!allowed) allowed = (await requestPermission()) === "granted";
  }
  if (allowed) sendNotification({ title, body: text });
}

async function toast(list: Toast[]) {
  for (const t of list.slice(-20)) await notify(t.name || t.chat || "iMessage", t.text || "", t.chat || "");
}

void listen("blip://mark-all-read", () => poller.markAllRead());
void listen<string>("blip://open-chat", (e) => view.goto(e.payload));

// Default global shortcut to raise Blip. Win+ combinations are reserved by
// the shell on Windows, so this is Ctrl+Alt+M.
void register("Ctrl+Alt+M", (e) => {
  if (e.state === "Pressed") void invoke("show_main");
}).catch(() => { /* taken by another app: the tray still works */ });

// ---- first run: no bridge.conf yet means no Mac to talk to. The setup
// itself runs in a console window (blip-setup.ps1), where ssh can ask for
// the Mac's password and fingerprint.
interface SetupState { configured: boolean; host: string; shims: boolean }

function setupScreen(): Promise<void> {
  return new Promise((done) => {
    const box = document.createElement("div");
    box.className = "setup";
    box.innerHTML = `
      <div class="setup-card">
        <h1>Set up Blip</h1>
        <p>Blip reads and sends iMessage through a Mac you own. The Mac must be signed into your
        Apple ID, stay awake, and have <b>Remote Login</b> on (System Settings &rarr; General &rarr; Sharing).</p>
        <label>Mac address <input id="setup-host" placeholder="you@your-mac" spellcheck="false"></label>
        <p class="setup-hint">Your Mac login name and its name on the network, or its Tailscale name.
        A console window opens next; it may ask you to confirm the Mac's fingerprint and type its
        password once. Then be at the Mac to click <b>Allow</b> when it asks.</p>
        <button id="setup-go">Set up</button>
        <p id="setup-msg" class="setup-msg"></p>
      </div>`;
    document.body.append(box);
    const input = box.querySelector<HTMLInputElement>("#setup-host")!;
    const go = box.querySelector<HTMLButtonElement>("#setup-go")!;
    const msg = box.querySelector<HTMLParagraphElement>("#setup-msg")!;
    input.focus();
    const run = async () => {
      const host = input.value.trim();
      if (!host) return input.focus();
      go.disabled = true;
      msg.textContent = "Setup is running in the console window…";
      try {
        const code = await invoke<number>("run_setup", { host });
        const s = await invoke<SetupState>("setup_state");
        if (code === 0 && s.configured) {
          box.remove();
          done();
          return;
        }
        msg.textContent = `Setup did not finish (exit ${code}). Read the console output, fix what it says, and try again.`;
      } catch (e) {
        msg.textContent = String(e);
      }
      go.disabled = false;
    };
    go.onclick = run;
    input.onkeydown = (e) => { if (e.key === "Enter") void run(); };
  });
}

async function boot() {
  const s = await invoke<SetupState>("setup_state");
  if (!s.configured) await setupScreen();
  void invoke("start_watch");
  void poller.start();
}
void boot();
