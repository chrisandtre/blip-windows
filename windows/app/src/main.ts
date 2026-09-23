import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { register } from "@tauri-apps/plugin-global-shortcut";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { Toast } from "./bridge";
import { Poller } from "./poller";
import { View } from "./view";
import "./style.css";

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
let allowed: boolean | null = null;
async function notify(title: string, body: string) {
  if (allowed === null) {
    allowed = await isPermissionGranted();
    if (!allowed) allowed = (await requestPermission()) === "granted";
  }
  if (allowed) sendNotification({ title, body: body.length > 220 ? body.slice(0, 217) + "…" : body });
}

async function toast(list: Toast[]) {
  for (const t of list.slice(-20)) await notify(t.name || t.chat || "iMessage", t.text || "");
}

void listen("blip://mark-all-read", () => poller.markAllRead());

// Default global shortcut to raise Blip. Win+ combinations are reserved by
// the shell on Windows, so this is Ctrl+Alt+M.
void register("Ctrl+Alt+M", (e) => {
  if (e.state === "Pressed") void invoke("show_main");
}).catch(() => { /* taken by another app: the tray still works */ });

void invoke("start_watch");
void poller.start();
