// BarWidget.qml's poller, ported: ONE collector run at a time, a coalescing
// queue, the optimistic-read ledger, and `imsg watch` pings. References are
// to BarWidget.qml.
import { listen } from "@tauri-apps/api/event";
import { core, json, type CollectorOut, type SecurityCode, type Thread, type Toast } from "./bridge";
import { noteMacSeconds } from "./clock";

interface Req { deep: boolean; markRead: boolean; readChat: string; seen: string }

export interface Reader {
  /** The chat being READ right now ("" if none): open, rendered, window focused, not peeking. */
  activeReadChat(): string;
  /** Newest visible non-pending ts in that chat. */
  activeSeenTs(): string;
  surfaceOpen(): boolean;
  /** A watch ping: reload the open conversation (BlipView.pushReload). */
  pushReload(): void;
}

export interface PollerEvents {
  threads(list: Thread[]): void;
  status(s: { online: boolean; healthy: boolean; unread: number; error: string }): void;
  toasts(list: Toast[]): void;
  code(c: SecurityCode): void;
}

/** pinned first, pin_order ascending (numeric beats null), then newest (:328-340). */
export function compareThreads(a: Thread, b: Thread): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned) {
    const ao = a.pin_order, bo = b.pin_order;
    if (ao !== bo) {
      if (ao == null) return 1;
      if (bo == null) return -1;
      return ao - bo;
    }
  }
  return a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0;
}

export class Poller {
  threads: Thread[] = [];
  unread = 0;
  online = true;
  healthy = true;
  lastError = "";
  readPush = "all";
  watchAlive = false;

  private threadsJson = "";
  private deepThreads: Thread[] = [];
  private queue: Req[] = [];
  private running = false;
  private localReads = new Map<string, { ts: string; at: number }>();
  private timer: number | undefined;
  private pingTimer: number | undefined;
  private liveness: number | undefined;

  constructor(private reader: Reader, private on: PollerEvents) {}

  async start() {
    await listen<string>("blip://watch", (e) => this.watchLine(e.payload));
    await listen<string>("blip://watch-state", (e) => {
      if (e.payload === "down") this.setWatch(false);
    });
    this.tick();
  }

  // ---- cadence (:565-580): 60 s with a live watcher, 6 s online, 30 s offline
  private schedule() {
    clearTimeout(this.timer);
    const ms = this.watchAlive ? 60_000 : this.online ? 6_000 : 30_000;
    this.timer = window.setTimeout(() => this.tick(), ms);
  }

  private tick() {
    this.refresh(this.reader.surfaceOpen() || this.deepThreads.length === 0, false,
      this.reader.activeReadChat(), this.reader.activeSeenTs());
    this.schedule();
  }

  // ---- watch (:594-654). Restart/backoff lives in the Rust side.
  private setWatch(alive: boolean) {
    if (this.watchAlive !== alive) {
      this.watchAlive = alive;
      this.schedule();
    }
  }

  private watchLine(line: string) {
    clearTimeout(this.liveness);
    // 90 s of silence (the Mac sends hb every ~30 s) means the watcher is dead.
    this.liveness = window.setTimeout(() => this.setWatch(false), 90_000);
    if (line === "ready") return this.setWatch(true);
    if (line === "hb") return;
    noteMacSeconds(line); // the Mac's clock (clock.ts)
    this.setWatch(true);
    clearTimeout(this.pingTimer);
    this.pingTimer = window.setTimeout(() => {
      this.refresh(this.reader.surfaceOpen(), false, this.reader.activeReadChat(), this.reader.activeSeenTs());
      this.reader.pushReload();
    }, 250);
  }

  // ---- queue (:343-378, :549-562)
  refresh(deep: boolean, markRead = false, readChat = "", seen = "") {
    const req: Req = { deep, markRead, readChat: String(readChat || ""), seen: String(seen || "") };
    if (this.running) return this.enqueue(req);
    this.run(req);
  }

  private enqueue(req: Req) {
    if (!req.markRead) {
      const same = this.queue.find((q) => !q.markRead && q.readChat === req.readChat);
      if (same) {
        same.deep = same.deep || req.deep;
        if (req.seen > same.seen) same.seen = req.seen;
        return;
      }
    }
    this.queue.push(req);
  }

  private async run(req: Req) {
    this.running = true;
    const args: string[] = [];
    if (req.deep) args.push("--deep");
    if (req.markRead) args.push("--mark-read");
    if (req.readChat) {
      args.push("--read", req.readChat);
      if (req.seen) args.push("--seen", req.seen);
    }
    try {
      const out = await core("collector", args, undefined, 45_000);
      const d = json<CollectorOut>(out);
      if (!d) {
        this.healthy = false;
        this.lastError = out.code !== 0 ? (out.stderr.trim().split("\n").pop() || `collector exit ${out.code}`) : "collector produced unparseable output";
      } else {
        this.consume(d);
        if (out.code !== 0) this.healthy = false;
      }
    } catch (e) {
      // The core could not start at all (bun or blip-core.exe missing).
      this.online = false;
      this.healthy = false;
      this.lastError = `cannot run the Blip core: ${e}`;
    }
    this.emitStatus();
    const next = this.queue.shift();
    this.running = false;
    if (next) queueMicrotask(() => this.refresh(next.deep, next.markRead, next.readChat, next.seen));
  }

  // ---- result (:491-547)
  private consume(d: CollectorOut) {
    this.online = d.online === true;
    this.lastError = d.error || "";
    if (typeof d.readPush === "string") this.readPush = d.readPush;
    if (!d.ok) {
      this.healthy = false;
      if (!this.online) this.unread = 0;
      return;
    }
    let list = this.applyLocalReads(d.threads || []);
    if (d.deep === true) this.deepThreads = list;
    else if (this.deepThreads.length) list = this.overlay(this.deepThreads, list);
    this.setThreads(list);
    this.healthy = d.persisted !== false;

    const codeKeys = new Set((d.codes || []).map((c) => c.chat + "\0" + c.ts));
    const toasts = (d.toast || []).filter((t) => !codeKeys.has(t.chat + "\0" + t.ts));
    const failed = (d.failures || []).map((f) => ({ ...f, name: "⚠ Not delivered to " + f.name }));
    if (toasts.length || failed.length) this.on.toasts([...toasts, ...failed]);
    const codes = d.codes || [];
    if (codes.length) this.on.code(codes[codes.length - 1]!);
  }

  private setThreads(list: Thread[]) {
    const j = JSON.stringify(list);
    if (j !== this.threadsJson) {
      this.threadsJson = j;
      this.threads = list;
      this.on.threads(list);
    }
    this.unread = list.reduce((n, t) => n + (t.unread || 0), 0);
  }

  /** Walk the deep list, taking shallow rows where present; a deep row the
   *  shallow window no longer shows unread is read (:312-327). */
  private overlay(deep: Thread[], shallow: Thread[]): Thread[] {
    const by = new Map(shallow.map((t) => [t.chat, t]));
    const out = deep.map((t) => by.get(t.chat) ?? { ...t, unread: 0 });
    const seen = new Set(deep.map((t) => t.chat));
    for (const t of shallow) if (!seen.has(t.chat)) out.push(t);
    return out.sort(compareThreads);
  }

  // ---- optimistic reads (:391-445)
  private applyLocalReads(list: Thread[]): Thread[] {
    const now = Date.now();
    return list.map((t) => {
      const r = this.localReads.get(t.chat);
      if (!r) return t;
      if (t.unread === 0 || now - r.at > 60_000) {
        this.localReads.delete(t.chat);
        return t;
      }
      if (String(t.last_ts) > r.ts) return t;
      return { ...t, unread: 0 };
    });
  }

  markThreadRead(chat: string, seen: string) {
    const t = this.threads.find((x) => x.chat === chat);
    const lastTs = seen || t?.last_ts || "";
    this.localReads.set(chat, { ts: lastTs, at: Date.now() });
    if (t && t.unread) this.setThreads(this.threads.map((x) => (x.chat === chat ? { ...x, unread: 0 } : x)));
    this.emitStatus();
    this.refresh(true, false, chat, lastTs);
  }

  markAllRead() {
    for (const t of this.threads) this.localReads.set(t.chat, { ts: t.last_ts, at: Date.now() });
    this.setThreads(this.threads.map((t) => (t.unread ? { ...t, unread: 0 } : t)));
    this.emitStatus();
    this.refresh(this.reader.surfaceOpen(), true);
  }

  private emitStatus() {
    this.on.status({ online: this.online, healthy: this.healthy, unread: this.online ? this.unread : 0, error: this.lastError });
  }
}
