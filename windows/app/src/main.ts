// Two surfaces, one poller, as in Linux Blip (BarWidget.qml is the single
// poller; the popout and the window render what it has):
//
//   main   - the leader. Runs the poller, the watcher, notifications and the
//            tray status, and broadcasts every thread list and status change.
//            It exists for the app's whole life (closing it only hides it).
//   panel  - the tray popout, a follower. Renders the leader's lists and
//            forwards its reads, mark-all and refreshes to the leader.
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register } from "@tauri-apps/plugin-global-shortcut";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { Thread, Toast } from "./bridge";
import { Poller } from "./poller";
import { setupScreen, setupState } from "./setup";
import { View, type Control } from "./view";
import "./style.css";

// Mock mode (windows/app/dev/serve.ts): a plain browser with real reads and
// fake sends. The condition is a build-time constant, so a release drops it.
if (import.meta.env.VITE_BLIP_MOCK && !("__TAURI_INTERNALS__" in window)) await import("../dev/mock-tauri");

type Status = { online: boolean; healthy: boolean; unread: number; error: string };

if (getCurrentWindow().label === "panel") follower();
else void leader();

// ------------------------------------------------------------------ leader
async function leader() {
  let view!: View;
  let last: Status = { online: true, healthy: true, unread: 0, error: "" };
  const poller = new Poller(
    {
      activeReadChat: () => view.activeReadChat(),
      activeSeenTs: () => view.activeSeenTs(),
      surfaceOpen: () => view.surfaceOpen(),
      pushReload: () => view.pushReload(),
    },
    {
      threads: (list) => {
        view.setThreads(list);
        void emit("blip://threads", list);
      },
      status: (s) => {
        last = s;
        view.setStatus(s);
        void emit("blip://status", s);
        void invoke("set_status", { unread: s.unread, online: s.online });
      },
      toasts: (list) => void toast(list),
      code: (c) => {
        view.showCode(c);
        void notify("Security code", `From ${c.name || "a sender"}${c.domain ? " for " + c.domain : ""}. Open Blip to copy it.`);
      },
    },
  );
  // Mock mode can preview the popout layout: http://localhost:1420/?compact
  view = new View(poller, !!import.meta.env.VITE_BLIP_MOCK && location.search.includes("compact"));

  void listen("blip://mark-all-read", () => poller.markAllRead());
  void listen<string>("blip://open-chat", (e) => view.goto(e.payload));
  // The popout's requests.
  void listen<{ chat: string; seen: string }>("blip://mark-read", (e) => poller.markThreadRead(e.payload.chat, e.payload.seen));
  void listen<{ deep: boolean }>("blip://refresh", (e) => poller.refresh(e.payload.deep));
  void listen("blip://hello", () => {
    void emitTo("panel", "blip://threads", poller.threads);
    void emitTo("panel", "blip://status", last);
  });

  // Win+ combinations are reserved by the shell on Windows, so Ctrl+Alt+M.
  void register("Ctrl+Alt+M", (e) => {
    if (e.state === "Pressed") void invoke("show_main");
  }).catch(() => { /* taken by another app: the tray still works */ });

  const s = await setupState();
  if (!s.configured) await setupScreen();
  void invoke("start_watch");
  void poller.start();
}

// ---- notifications. The collector already applied the allowlist, the mute
// list and the "not while you're reading it" gate; the body is capped the
// way BarWidget caps it (220 chars). The shell's own `toast` command makes a
// click open the conversation; the plugin is the fallback.
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

// ------------------------------------------------------------------ follower
function follower() {
  const control: Control = {
    markThreadRead: (chat, seen) => void emitTo("main", "blip://mark-read", { chat, seen }),
    markAllRead: () => void emitTo("main", "blip://mark-all-read", null),
    refresh: (deep) => void emitTo("main", "blip://refresh", { deep }),
  };
  const view = new View(control, true);
  void listen<Thread[]>("blip://threads", (e) => view.setThreads(e.payload));
  void listen<Status>("blip://status", (e) => view.setStatus(e.payload));
  void listen<string>("blip://panel-shown", () => view.resetToList());
  // The leader's watcher pings every window; reload the open conversation too.
  let ping: number | undefined;
  void listen<string>("blip://watch", (e) => {
    if (e.payload === "ready" || e.payload === "hb") return;
    clearTimeout(ping);
    ping = window.setTimeout(() => view.pushReload(), 250);
  });
  void emitTo("main", "blip://hello", null);
}
