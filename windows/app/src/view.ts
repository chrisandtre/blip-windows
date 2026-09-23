// BlipView.qml, ported to the DOM: one surface with the conversation list and
// the open conversation side by side (the Omarchy window's split view).
// Message text is never parsed as HTML: every string from the Mac goes in as
// a text node, links included, because this webview can call the bridge.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import {
  core, fileSrc, filePath, json, shim, writeDraft,
  type Attachment, type Bubble, type PendingSend, type SecurityCode, type Thread,
} from "./bridge";
import type { Poller } from "./poller";
// The same helper modules the QML imports, so both front ends agree.
import { markSendFailed } from "../../../SendState.mjs";
import { quotedDraft } from "../../../MessageActions.mjs";

// ------------------------------------------------------------------ helpers

const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+\.[^\s<>"']+/g; // thread.ts:347
const AUTO_FETCH_MAX = 32 * 1024 * 1024; // BlipView.qml:968
const PREVIEW_CAP = "5242880"; // fetch.ts preview mode (BlipView.qml:960)
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === false ? "HH:mm" : "h:mm AP";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Text with links as <a> elements, built node by node (never innerHTML). */
function linked(text: string): DocumentFragment {
  const f = document.createDocumentFragment();
  let pos = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    let url = m[0].replace(/[.,;:!?\]]+$/, "");
    while (url.endsWith(")") && url.split("(").length < url.split(")").length) url = url.slice(0, -1);
    url = url.replace(/[.,;:!?\]]+$/, "");
    f.append(text.slice(pos, m.index));
    const a = h("a", "", url);
    a.dataset.href = url.startsWith("www.") ? "https://" + url : url;
    f.append(a);
    pos = m.index + url.length;
    URL_RE.lastIndex = pos;
  }
  f.append(text.slice(pos));
  return f;
}

function firstUrl(text: string): string {
  URL_RE.lastIndex = 0;
  const m = URL_RE.exec(text || "");
  if (!m) return "";
  const u = m[0].replace(/[.,;:!?\]]+$/, "");
  return u.startsWith("www.") ? "https://" + u : u;
}

function openLink(url: string) {
  if (/^https?:\/\//i.test(url)) void openUrl(url);
}

const stampMs = (ts: string) => Date.parse(/^\d{4}-\d\d-\d\d \d/.test(ts) ? ts.replace(" ", "T") : ts);
const localDay = (ms: number) => new Date(ms).toDateString();
/** "2026-09-22T18:33:12Z", the wire format every mark compares against. */
const wireStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Row and hit times, like BlipView.fmtTime (:1578-1596). */
function fmtTime(ts: string): string {
  const ms = stampMs(ts);
  if (!isFinite(ms)) return "";
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** Not a phone number or an email: a group id (BlipView.qml:463). */
const isGroupId = (c: string) => !!c && !/^\+?[0-9]{3,15}$/.test(c) && !c.includes("@");

/** A conversation we can address (:473-478). A group needs its guid. */
function isSendable(t: Thread | null): boolean {
  if (!t) return false;
  if (isGroupId(t.chat)) return /^[A-Za-z]+;[+-];.+$/.test(t.guid || "");
  return /^\+?[0-9]{3,15}$/.test(t.chat) || t.chat.indexOf("@") > 0;
}

function initials(name: string): string {
  const n = (name || "").trim();
  if (!n || /^[+0-9]/.test(n)) return "#";
  const w = n.split(/\s+/);
  return (w[0]![0]! + (w.length > 1 ? w[w.length - 1]![0]! : "")).toUpperCase();
}

const displayName = (t: Thread) => t.pin_name || t.name || t.handle || t.chat;
const avatarKey = (t: Thread) => (isGroupId(t.chat) ? t.chat : t.handle || t.chat);
const openableMime = (m: string) => /^(image|video|audio)\//.test(m) || ["application/pdf", "text/plain", "text/vcard", "text/calendar"].includes(m);

// ------------------------------------------------------------------ view

type Mode = "list" | "search" | "new";
type Hit = { chat: string; name: string; handle: string; service?: string; ts?: string; text?: string; kind?: string; group?: boolean };

export class View {
  threads: Thread[] = [];
  online = true;
  unread = 0;
  focused = true;

  private active: Thread | null = null;
  private bubbles: Bubble[] = [];
  private bubblesJson = "";
  private loading = false;
  private rendered = false;
  private seenTs = "";
  private firstLoad = true;
  private stick = true;
  private pushPending = false;
  private activeLastTs = "";
  private peeking = false;
  private cursor = -1;
  private mode: Mode = "list";
  private hits: Hit[] = [];
  private hitCursor = 0;

  private pendingSends: PendingSend[] = [];
  private pendingRevision = 0;
  private sendQueue: { chat: string; text: string; stamp: string; localId: number; target: string[] }[] = [];
  private sending = false;
  private nextSendId = 0;
  private attachDrafts: string[] = [];
  private drafts = new Map<string, string>();

  private threadRunning = "";
  private threadQueued = "";
  private attFiles = new Map<string, string>(); // attachment id -> file:// URL ("" = failed)
  private fetchQueue: { att: Attachment; action: "" | "open"; auto: boolean }[] = [];
  private fetching = new Set<string>();
  private linkCards = new Map<string, { title: string; summary: string; image: string; url: string } | null>();
  private previewQueue: string[] = [];
  private previewing = false;
  private avatars = new Map<string, string>(); // key -> file:// URL, "" = letters
  private avatarWanted = new Set<string>();
  private avatarTimer: number | undefined;
  private searchSeq = 0;
  private searchTimer: number | undefined;
  private code: SecurityCode | null = null;
  private codeTimer: number | undefined;

  // DOM
  private root = document.getElementById("app")!;
  private side = h("aside", "side");
  private headerEl = h("div", "side-head");
  private statusEl = h("div", "status");
  private searchEl = h("input", "search");
  private codeEl = h("div", "code-banner");
  private pinnedEl = h("div", "pinned");
  private listEl = h("div", "list");
  private main = h("main", "conv");
  private titleEl = h("div", "conv-title");
  private metaEl = h("div", "conv-meta");
  private scroller = h("div", "bubbles");
  private draftsEl = h("div", "drafts");
  private composer = h("textarea", "composer");
  private sendBtn = h("button", "send", "Send");
  private noteEl = h("div", "note");

  constructor(private poller: Poller) {
    this.build();
  }

  // ---------------------------------------------------------- Reader (poller)
  activeReadChat(): string {
    return this.readActive() && this.active && !this.loading && this.rendered ? this.active.chat : "";
  }
  activeSeenTs(): string {
    return this.activeReadChat() ? this.seenTs : "";
  }
  surfaceOpen(): boolean {
    return this.focused || document.visibilityState === "visible";
  }
  private readActive() {
    return this.focused && document.visibilityState === "visible" && !this.peeking;
  }

  // ---------------------------------------------------------- layout
  private build() {
    const newBtn = h("button", "icon-btn", "+");
    newBtn.title = "New message (n)";
    newBtn.onclick = () => this.startMode("new");
    const brand = h("div", "brand", "Messages");
    this.headerEl.append(brand, newBtn);
    this.searchEl.placeholder = "Search  ( / )";
    this.searchEl.spellcheck = false;
    this.searchEl.oninput = () => this.scheduleSearch();
    this.searchEl.onfocus = () => { if (this.mode === "list") this.startMode("search"); };
    this.searchEl.onkeydown = (e) => this.searchKey(e);
    this.codeEl.hidden = true;
    this.side.append(this.headerEl, this.statusEl, this.codeEl, this.searchEl, this.pinnedEl, this.listEl);

    const head = h("div", "conv-head");
    head.append(this.titleEl, this.metaEl);
    const bar = h("div", "compose");
    const attach = h("button", "icon-btn", "📎");
    attach.title = "Attach files";
    attach.onclick = () => this.pickAttachments();
    this.composer.rows = 1;
    this.composer.placeholder = "iMessage";
    this.composer.spellcheck = true;
    this.composer.oninput = () => this.composerInput();
    this.composer.onkeydown = (e) => this.composerKey(e);
    this.composer.onfocus = () => this.commitPeek();
    this.composer.addEventListener("paste", (e) => this.paste(e));
    this.sendBtn.onclick = () => this.send();
    bar.append(attach, this.composer, this.sendBtn);
    this.main.append(head, this.scroller, this.draftsEl, bar, this.noteEl);
    this.scroller.addEventListener("scroll", () => {
      const s = this.scroller;
      this.stick = s.scrollTop + s.clientHeight >= s.scrollHeight - 4;
      if (this.stick && this.pushPending && this.active) {
        this.pushPending = false;
        this.requestThreadLoad(this.active.chat);
      }
    });
    this.scroller.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
      if (a?.dataset.href) {
        e.preventDefault();
        openLink(a.dataset.href);
      }
    });
    this.root.append(this.side, this.main);
    this.renderConv();
    document.addEventListener("keydown", (e) => this.globalKey(e));

    void getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop" && this.active) {
        for (const p of e.payload.paths) this.addAttachment(p);
      }
    });
    void getCurrentWindow().onFocusChanged(({ payload }) => {
      this.focused = payload;
      // Looking at the open conversation again counts as reading it.
      if (payload && this.active && this.rendered && !this.loading) this.markRead(this.active.chat, this.seenTs);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.retryBareAvatars();
    });
  }

  // ---------------------------------------------------------- status + list
  setStatus(s: { online: boolean; healthy: boolean; unread: number; error: string }) {
    this.online = s.online;
    this.unread = s.unread;
    this.statusEl.textContent = "";
    if (!s.online) {
      this.statusEl.append(h("div", "offline", "Mac unreachable - bridge offline"),
        h("div", "offline-detail", "Blip keeps trying. Check that the Mac is awake and on the network."));
    } else {
      if (!s.healthy && s.error) this.statusEl.append(h("div", "warn", "⚠ " + s.error));
      if (s.unread > 0) {
        const row = h("div", "unread-row");
        row.append(h("span", "", `${s.unread} unread`));
        const all = h("a", "mark-all", "Mark all read");
        all.onclick = () => this.poller.markAllRead();
        row.append(all);
        this.statusEl.append(row);
      }
    }
    this.composer.readOnly = !s.online;
    this.side.classList.toggle("is-offline", !s.online);
  }

  setThreads(list: Thread[]) {
    this.threads = list;
    // Keep the open conversation's object fresh (a group may become sendable)
    // and reload it when its newest message changed (:425-461).
    if (this.active) {
      const t = list.find((x) => x.chat === this.active!.chat);
      if (t) {
        this.active = t;
        if (t.last_ts !== this.activeLastTs && this.threadRunning !== t.chat && this.threadQueued !== t.chat) {
          if (!this.stick) this.pushPending = true;
          else this.requestThreadLoad(t.chat);
        }
        this.activeLastTs = t.last_ts;
        this.renderHead();
      }
    }
    if (this.mode === "list") this.renderList();
  }

  private renderList() {
    const pinned = this.threads.filter((t) => t.pinned);
    const rows = this.threads.filter((t) => !t.pinned);
    this.pinnedEl.textContent = "";
    this.pinnedEl.hidden = pinned.length === 0 || this.mode !== "list";
    pinned.forEach((t, i) => {
      const tile = h("button", "tile" + (this.active?.chat === t.chat ? " is-active" : ""));
      tile.title = `${displayName(t)}  (Ctrl+${i + 1})`;
      tile.append(this.avatar(t, 52));
      const name = h("div", "tile-name", displayName(t));
      if (t.unread) name.prepend(h("span", "dot"));
      tile.append(name);
      tile.onclick = () => this.openThread(t, true);
      this.pinnedEl.append(tile);
    });
    // Emptying the list clamps its scroll to 0; put it back after the rebuild.
    const keep = this.listEl.scrollTop;
    queueMicrotask(() => { this.listEl.scrollTop = keep; });
    this.listEl.textContent = "";
    if (this.mode !== "list") return this.renderHits();
    if (!this.online) return;
    rows.forEach((t) => {
      const idx = this.threads.indexOf(t);
      const row = h("button", "row" + (t.unread ? " is-unread" : "") + (this.active?.chat === t.chat ? " is-active" : "") + (idx === this.cursor ? " is-cursor" : ""));
      row.append(h("span", t.unread ? "dot" : "dot-space"), this.avatar(t, 40));
      const body = h("div", "row-body");
      const top = h("div", "row-top");
      top.append(h("span", "row-name", displayName(t)), h("span", "row-time", fmtTime(t.last_ts)));
      const prev = h("div", "row-prev", (t.last_from_me ? "You: " : "") + (t.last_text || ""));
      body.append(top, prev);
      row.append(body);
      row.onclick = () => this.openThread(t, true);
      this.listEl.append(row);
    });
  }

  // ---------------------------------------------------------- avatars (:845-922)
  private avatar(t: Thread | Hit, size: number): HTMLElement {
    const key = "chat" in t && isGroupId(t.chat) ? t.chat : t.handle || t.chat;
    const box = h("div", "avatar");
    box.style.width = box.style.height = size + "px";
    const url = this.avatars.get(key);
    if (url) {
      const img = h("img");
      img.src = fileSrc(url);
      img.onerror = () => { this.avatars.set(key, ""); img.remove(); box.textContent = initials(t.name); };
      box.append(img);
    } else {
      box.textContent = isGroupId(t.chat) && !t.name ? "👥" : initials(t.name || t.handle);
      box.style.fontSize = Math.round(size * 0.38) + "px";
      if (url === undefined) this.requestAvatar(key);
    }
    return box;
  }

  private requestAvatar(key: string) {
    if (!key || this.avatarWanted.has(key)) return;
    this.avatarWanted.add(key);
    clearTimeout(this.avatarTimer);
    this.avatarTimer = window.setTimeout(() => this.fetchAvatars(), 30);
  }

  /** Small batches, rendered as each lands. The QML streams avatar.ts's
   *  JSONL instead; one big batch waited on as a whole timed out whenever the
   *  "no photo" markers were older than 15 min and every handle went back to
   *  the Mac (~0.3 s each), and then every row fell back to initials. */
  private fetchingAvatars = false;
  private async fetchAvatars() {
    if (this.fetchingAvatars) return;
    this.fetchingAvatars = true;
    try {
      for (;;) {
        const keys = [...this.avatarWanted].filter((k) => !this.avatars.has(k)).slice(0, 16);
        if (!keys.length) break;
        const out = await core("avatar", ["--batch", "--retry"], keys.join("\n") + "\n", 60_000).catch(() => null);
        for (const line of (out?.stdout || "").split("\n")) {
          try {
            const r = JSON.parse(line) as { handle: string; ok: boolean; url: string };
            this.avatars.set(r.handle, r.ok ? r.url : "");
          } catch { /* not a result line */ }
        }
        for (const k of keys) if (!this.avatars.has(k)) this.avatars.set(k, "");
        this.renderList();
        this.renderHead();
      }
    } finally {
      this.fetchingAvatars = false;
    }
  }

  private retryBareAvatars() {
    for (const [k, v] of this.avatars) if (v === "") { this.avatars.delete(k); this.avatarWanted.delete(k); }
  }

  // ---------------------------------------------------------- open a thread
  openThread(t: Thread, focusComposer: boolean) {
    if (this.active?.chat === t.chat && this.peeking) {
      this.commitPeek();
    } else if (this.active?.chat !== t.chat) {
      this.showThread(t);
    }
    this.peeking = false;
    this.cursor = this.threads.indexOf(t);
    this.renderList();
    if (focusComposer) this.composer.focus();
  }

  private showThread(t: Thread, peek = false) {
    if (this.active) this.drafts.set(this.active.chat, this.composer.value);
    this.active = t;
    this.peeking = peek;
    this.bubbles = [];
    this.bubblesJson = "";
    this.loading = true;
    this.rendered = false;
    this.seenTs = "";
    this.firstLoad = true;
    this.stick = true;
    this.pushPending = false;
    this.activeLastTs = t.last_ts;
    this.attachDrafts = [];
    this.composer.value = this.drafts.get(t.chat) || "";
    this.composerInput();
    this.noteEl.textContent = "";
    this.renderConv();
    this.requestThreadLoad(t.chat);
  }

  private commitPeek() {
    if (!this.peeking) return;
    this.peeking = false;
    if (this.active && !this.loading) this.markRead(this.active.chat, this.seenTs);
  }

  private markRead(chat: string, seen: string) {
    if (!this.readActive()) return;
    this.poller.markThreadRead(chat, seen);
  }

  // ---------------------------------------------------------- thread loading (:589-680)
  private requestThreadLoad(chat: string) {
    this.threadQueued = chat;
    if (!this.threadRunning) void this.nextThreadLoad();
  }

  /** A watch ping: reload the open conversation, or defer until the reader
   *  scrolls back to the bottom (:1332-1339). */
  pushReload() {
    if (!this.active || !this.surfaceOpen()) return;
    if (!this.stick) { this.pushPending = true; return; }
    if (this.threadRunning && this.threadQueued) return;
    this.requestThreadLoad(this.active.chat);
  }

  private async nextThreadLoad() {
    const chat = this.threadQueued;
    if (!chat) return;
    this.threadQueued = "";
    this.threadRunning = chat;
    const revision = this.pendingRevision;
    const pending = this.pendingSends.filter((p) => p.chat === chat);
    const args = [chat, "80", "--time-format", TIME_FORMAT, "--date-format", "MMM d", "--date-format-with-year", "MMM d, yyyy"];
    if (pending.length) args.push("--pending-stdin");
    const out = await core("thread", args, pending.length ? JSON.stringify(pending) : undefined).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
    this.threadRunning = "";
    if (this.active?.chat === chat) {
      if (revision !== this.pendingRevision) {
        // A send or a failure happened while this ran: its bubbles are stale.
        this.requestThreadLoad(chat);
      } else {
        this.threadResult(chat, out.code, json<{ ok: boolean; online: boolean; error: string; bubbles: Bubble[]; pending?: PendingSend[] }>(out));
      }
    }
    if (this.threadQueued) void this.nextThreadLoad();
  }

  private reloadTries = 0;
  private threadResult(chat: string, code: number, d: { ok: boolean; error: string; bubbles: Bubble[]; pending?: PendingSend[] } | null) {
    this.loading = false;
    if (!d) {
      this.noteEl.textContent = `thread loader failed (exit ${code})`;
      this.renderHead();
      return;
    }
    if (!d.ok) {
      this.bubbles = [];
      this.rendered = false;
      this.noteEl.textContent = d.error;
      this.renderConv();
      return;
    }
    const list = d.bubbles || [];
    let seen = "";
    for (const b of list) if (!b.pending && !b.scheduled && b.ts > seen) seen = b.ts;
    if (d.pending) {
      this.pendingSends = this.pendingSends.filter((p) => p.chat !== chat).concat(d.pending);
      // Sends still in flight: look again shortly, up to 8 times (:1629-1639).
      if (d.pending.some((p) => !p.failed) && this.reloadTries < 8) {
        this.reloadTries++;
        window.setTimeout(() => this.active?.chat === chat && this.requestThreadLoad(chat), 600);
      }
    }
    const j = JSON.stringify(list);
    this.rendered = true;
    this.seenTs = seen;
    if (j !== this.bubblesJson) {
      this.bubblesJson = j;
      this.bubbles = list;
      const pin = this.firstLoad || this.stick;
      this.firstLoad = false;
      this.renderConv(pin);
      this.autoFetchImages();
    } else {
      this.renderHead();
    }
    this.markRead(chat, seen);
  }

  // ---------------------------------------------------------- rendering
  private renderHead() {
    const t = this.active;
    this.titleEl.textContent = t ? displayName(t) : "";
    const meta = !t ? "" : isGroupId(t.chat)
      ? (isSendable(t) ? "group" : "group · read-only (id unknown)") + (t.participants?.length ? ` · ${t.participants.length} people` : "")
      : (t.handle && t.handle !== displayName(t) ? t.handle : t.service || "");
    this.metaEl.textContent = (this.loading ? "loading… " : "") + meta;
  }

  private renderConv(pinBottom = true) {
    this.renderHead();
    const t = this.active;
    this.main.classList.toggle("is-empty", !t);
    this.scroller.textContent = "";
    if (!t) {
      this.scroller.append(h("div", "empty", "Pick a conversation"));
      this.renderDrafts();
      return;
    }
    const group = isGroupId(t.chat);
    for (const b of this.bubbles) this.scroller.append(this.bubble(b, group));
    this.renderDrafts();
    if (pinBottom) requestAnimationFrame(() => { this.scroller.scrollTop = this.scroller.scrollHeight; this.stick = true; });
  }

  private bubble(b: Bubble, group: boolean): HTMLElement {
    const wrap = h("div", "msg" + (b.from_me ? " mine" : " theirs") + (b.groupStart ? " start" : "") + (b.groupEnd ? " end" : ""));
    if (b.day) wrap.append(h("div", "day", b.day));
    if (b.retracted) {
      wrap.append(h("div", "tombstone", `${b.from_me ? "You" : b.name || "They"} unsent a message`));
      return wrap;
    }
    if (group && !b.from_me && b.groupStart && b.name) wrap.append(h("div", "sender", b.name));
    if (b.replyText) wrap.append(h("div", "reply", "↩ " + (b.replyMine ? "You: " : "") + b.replyText));

    const card = b.link ?? null;
    const url = !card ? firstUrl(b.text) : "";
    const fetched = url ? this.linkCards.get(url) : undefined;
    if (url && fetched === undefined) this.requestPreview(url);
    const shownCard = card
      ? { url: card.url, title: card.title, summary: card.summary, image: card.image_id ? this.attFiles.get(card.image_id) || "" : "" }
      : fetched || null;
    const textIsJustUrl = !!shownCard && b.text.trim() === shownCard.url;

    for (const att of b.attachments || []) wrap.append(this.attachment(att, b.from_me));
    if (shownCard) {
      const c = h("div", "card");
      if (shownCard.image) { const img = h("img"); img.src = fileSrc(shownCard.image); c.append(img); }
      c.append(h("div", "card-title", shownCard.title || shownCard.url), h("div", "card-url", new URL(shownCard.url.startsWith("http") ? shownCard.url : "https://" + shownCard.url).host));
      c.onclick = () => openLink(shownCard.url);
      wrap.append(c);
    }
    if (b.text && !textIsJustUrl && !(b.text.trim() === "" && b.attachments?.length)) {
      const bub = h("div", "bubble");
      bub.append(linked(b.text));
      bub.oncontextmenu = (e) => { e.preventDefault(); this.bubbleMenu(b, e); };
      wrap.append(bub);
    }
    if (b.tapbacks?.length) wrap.append(h("div", "tapbacks", b.tapbacks.map((x) => x.emoji).join("")));

    const cap = [
      b.failed ? "⚠ Not Delivered" : "",
      b.failed ? b.failureReason || "" : b.pending ? "Sending…" : b.scheduled ? `Scheduled for ${b.scheduledFor || ""}` : b.time,
      b.edited ? "Edited" : "",
      b.effect ? "sent with " + b.effect : "",
    ].filter(Boolean).join(" · ");
    if (cap) wrap.append(h("div", "caption" + (b.failed ? " failed" : ""), cap));
    if (b.receipt) wrap.append(h("div", "receipt", b.receipt));
    return wrap;
  }

  private attachment(att: Attachment, mine: boolean): HTMLElement {
    const url = this.attFiles.get(att.id);
    if (url && att.mime.startsWith("image/")) {
      const img = h("img", "att-img");
      img.src = fileSrc(url);
      img.alt = att.name;
      img.onclick = () => this.openAttachment(att);
      img.onload = () => { if (this.stick) this.scroller.scrollTop = this.scroller.scrollHeight; };
      return img;
    }
    const chip = h("button", "chip" + (mine ? " mine" : ""));
    const state = url === "" ? "⚠ " : this.fetching.has(att.id) ? "⏳ " : "";
    const icon = att.mime.startsWith("image/") ? "🖼" : att.mime.startsWith("video/") ? "🎞" : att.mime.startsWith("audio/") ? "🎤" : att.mime === "application/pdf" ? "📄" : "📎";
    chip.textContent = `${state}${icon} ${att.name || att.mime}`;
    chip.onclick = () => this.openAttachment(att);
    return chip;
  }

  private bubbleMenu(b: Bubble, e: MouseEvent) {
    document.querySelector(".menu")?.remove();
    const m = h("div", "menu");
    const item = (label: string, fn: () => void) => { const i = h("button", "", label); i.onclick = () => { m.remove(); fn(); }; m.append(i); };
    if (this.online && isSendable(this.active)) item("Quote and reply", () => { this.composer.value = quotedDraft(b, this.composer.value); this.composer.focus(); this.composerInput(); });
    item("Copy message", () => void navigator.clipboard.writeText(b.text));
    const url = b.link?.url || firstUrl(b.text);
    if (url) { item("Open link", () => openLink(url)); item("Copy link", () => void navigator.clipboard.writeText(url)); }
    m.style.left = e.clientX + "px";
    m.style.top = e.clientY + "px";
    document.body.append(m);
    setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }));
  }

  // ---------------------------------------------------------- attachments in (:935-1000)
  private autoFetchImages() {
    for (const b of this.bubbles) {
      for (const a of b.attachments || []) {
        if (a.mime.startsWith("image/") && typeof a.bytes === "number" && a.bytes > 0 && a.bytes <= AUTO_FETCH_MAX) this.enqueueFetch(a, "", true);
      }
      if (b.link?.image_id) this.enqueueFetch({ id: b.link.image_id, name: "preview.png", mime: "image/png", bytes: null }, "", true);
    }
  }

  private openAttachment(att: Attachment) {
    if (this.attFiles.get(att.id) === "") this.attFiles.delete(att.id);
    this.enqueueFetch(att, "open", false);
  }

  private enqueueFetch(att: Attachment, action: "" | "open", auto: boolean) {
    if (this.fetching.has(att.id)) return;
    const queued = this.fetchQueue.find((q) => q.att.id === att.id);
    if (queued) { if (action) queued.action = action; return; }
    if (this.attFiles.has(att.id) && !action) return;
    this.fetchQueue.push({ att, action, auto });
    if (this.fetching.size === 0) void this.pumpFetch();
  }

  private async pumpFetch() {
    const job = this.fetchQueue.shift();
    if (!job) return;
    const { att, action, auto } = job;
    this.fetching.add(att.id);
    const out = await core("fetch", [att.id, att.name || "attachment", att.mime || "", auto ? PREVIEW_CAP : ""], undefined, 180_000).catch(() => null);
    this.fetching.delete(att.id);
    const d = out ? json<{ ok: boolean; online: boolean; url: string; path: string; error: string }>(out) : null;
    if (d?.ok) {
      this.attFiles.set(att.id, d.url);
      if (action === "open") {
        if (openableMime(att.mime)) void openPath(d.path);
        else this.noteEl.textContent = `saved, not opened (${att.mime}): ${d.path}`;
      }
    } else {
      this.attFiles.set(att.id, "");
      if (action) this.noteEl.textContent = d && d.online === false ? "fetch failed - Mac unreachable" : `fetch failed - ${d?.error || "no answer"}`;
    }
    const keep = this.scroller.scrollTop;
    this.renderConv(this.stick);
    if (!this.stick) this.scroller.scrollTop = keep;
    void this.pumpFetch();
  }

  // ---------------------------------------------------------- link previews (:803-840)
  private requestPreview(url: string) {
    if (this.linkCards.has(url) || this.previewQueue.includes(url)) return;
    this.previewQueue.push(url);
    if (!this.previewing) void this.pumpPreview();
  }

  private async pumpPreview() {
    const url = this.previewQueue.shift();
    if (!url) { this.previewing = false; return; }
    this.previewing = true;
    const out = await core("linkpreview", ["--stdin"], url, 20_000).catch(() => null);
    const d = out ? json<{ ok: boolean; url: string; title: string; summary: string; image: string }>(out) : null;
    this.linkCards.set(url, d?.ok ? { title: d.title, summary: d.summary, image: d.image, url } : null);
    if (d?.ok) { const keep = this.scroller.scrollTop; this.renderConv(this.stick); if (!this.stick) this.scroller.scrollTop = keep; }
    void this.pumpPreview();
  }

  // ---------------------------------------------------------- compose + send (:1386-1541)
  private composerInput() {
    const c = this.composer;
    c.style.height = "auto";
    c.style.height = Math.min(c.scrollHeight, 160) + "px";
    if (this.active) this.drafts.set(this.active.chat, c.value);
  }

  private composerKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.focusList();
    } else if (e.key === "ArrowLeft" && this.composer.selectionStart === 0 && this.composer.selectionEnd === 0) {
      e.preventDefault();
      this.focusList();
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      this.scroller.scrollBy({ top: (e.key === "PageUp" ? -1 : 1) * this.scroller.clientHeight * 0.9 });
    }
  }

  private target(t: Thread): string[] {
    if (isGroupId(t.chat)) return ["--chat-id", t.guid];
    const svc = /^(SMS|RCS)$/i.test(t.service || "") ? ["--service", t.service.toUpperCase()] : [];
    return ["--to", t.chat, ...svc];
  }

  send() {
    const t = this.active;
    const raw = this.composer.value;
    const text = raw.trim();
    if (!t || (!text && !this.attachDrafts.length)) return;
    if (!this.online) return;
    if (!isSendable(t)) { this.noteEl.textContent = "Read-only - group id unknown - send from your phone"; return; }
    if (this.attachDrafts.length) return void this.sendFiles(t, text);
    const stamp = wireStamp();
    const localId = ++this.nextSendId;
    this.pendingRevision++;
    this.pendingSends.push({ chat: t.chat, text, ts: stamp, localId });
    this.appendPendingBubble(text, stamp, localId);
    this.composer.value = "";
    this.composerInput();
    this.noteEl.textContent = "";
    // The raw text goes on stdin, never argv (CLAUDE.md invariant).
    this.sendQueue.push({ chat: t.chat, text: raw, stamp, localId, target: this.target(t) });
    void this.pumpSend();
  }

  /** The local echo: join the previous run if it is mine, same day, <=15 min (:1475-1487). */
  private appendPendingBubble(text: string, ts: string, localId: number) {
    const prev = this.bubbles[this.bubbles.length - 1];
    const join = !!prev && prev.from_me && localDay(stampMs(prev.ts)) === localDay(stampMs(ts)) && stampMs(ts) - stampMs(prev.ts) <= 15 * 60_000;
    const newDay = !prev || localDay(stampMs(prev.ts)) !== localDay(stampMs(ts));
    const list = this.bubbles.slice();
    if (join && prev) list[list.length - 1] = { ...prev, groupEnd: false, time: "" };
    list.push({
      ts, from_me: true, name: "", text, day: newDay ? "Today" : "", groupStart: !join, groupEnd: true, time: "",
      receipt: "", tapbacks: [], attachments: [], replyText: "", replyMine: false, edited: false, link: null,
      retracted: false, effect: "", pending: true, localId,
    });
    this.bubbles = list;
    this.bubblesJson = "";
    this.renderConv(true);
  }

  private async pumpSend() {
    if (this.sending) return;
    const job = this.sendQueue.shift();
    if (!job) return;
    this.sending = true;
    this.reloadTries = 0;
    const out = await shim("imsg-send", [...job.target, "--yes", "--text-stdin", "--keep-dashes"], job.text, 60_000)
      .catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
    this.sending = false;
    if (out.code === 0) {
      window.setTimeout(() => this.active?.chat === job.chat && this.requestThreadLoad(job.chat), 600);
    } else {
      const lastErr = out.stderr.trim().split("\n").filter(Boolean).pop() || "";
      const reason = out.code === 69 || out.code === 255 ? "Mac unreachable" : lastErr || `Send failed (exit ${out.code})`;
      this.failPending(job, reason);
      this.noteEl.textContent = out.code === 69 || out.code === 255 ? "not sent - Mac unreachable" : "send failed: " + reason;
      if (this.active?.chat === job.chat && !this.composer.value) { this.composer.value = job.text; this.composerInput(); }
    }
    void this.pumpSend();
  }

  private failPending(job: { chat: string; text: string; stamp: string; localId: number }, reason: string) {
    this.pendingRevision++;
    this.pendingSends = markSendFailed(this.pendingSends, job.localId, reason,
      { chat: job.chat, text: job.text.trim(), ts: job.stamp, localId: job.localId }) as PendingSend[];
    if (this.active?.chat === job.chat) {
      if (!this.bubbles.some((b) => b.localId === job.localId)) this.appendPendingBubble(job.text.trim(), job.stamp, job.localId);
      this.bubbles = markSendFailed(this.bubbles as never[], job.localId, reason) as unknown as Bubble[];
      this.bubbles = this.bubbles.map((b) => (b.localId === job.localId ? { ...b, pending: false } : b));
      this.bubblesJson = "";
      this.renderConv(this.stick);
    }
  }

  private async sendFiles(t: Thread, caption: string) {
    if (this.sending) { this.noteEl.textContent = "a message is already sending"; return; }
    this.sending = true;
    const svc = /^(SMS|RCS)$/i.test(t.service || "") ? ["--service", t.service.toUpperCase()] : [];
    let first = true;
    while (this.attachDrafts.length) {
      const path = this.attachDrafts[0]!;
      this.noteEl.textContent = `sending… (${this.attachDrafts.length} left)`;
      const out = await core("send-file", [t.chat, path, "--caption-stdin", ...svc], first ? caption : "", 300_000).catch(() => null);
      const d = out ? json<{ ok: boolean; online: boolean; error: string }>(out) : null;
      if (!d?.ok) {
        this.noteEl.textContent = `${d?.online === false ? "Mac unreachable" : d?.error || "send failed"} - ${this.attachDrafts.length} still attached`;
        break;
      }
      first = false;
      this.attachDrafts.shift();
      this.renderDrafts();
      window.setTimeout(() => this.active?.chat === t.chat && this.requestThreadLoad(t.chat), 600);
    }
    if (!this.attachDrafts.length) {
      this.noteEl.textContent = "";
      if (this.composer.value.trim() === caption) { this.composer.value = ""; this.composerInput(); }
    }
    this.sending = false;
    this.renderDrafts();
  }

  private addAttachment(path: string) {
    if (!path || this.attachDrafts.includes(path) || this.attachDrafts.length >= 10) return;
    this.attachDrafts.push(path);
    this.renderDrafts();
  }

  private renderDrafts() {
    this.draftsEl.textContent = "";
    this.draftsEl.hidden = this.attachDrafts.length === 0;
    for (const p of this.attachDrafts) {
      const chip = h("span", "draft", p.split(/[\\/]/).pop() || p);
      const x = h("button", "x", "✕");
      x.onclick = () => { this.attachDrafts = this.attachDrafts.filter((d) => d !== p); this.renderDrafts(); };
      chip.append(x);
      this.draftsEl.append(chip);
    }
  }

  private async pickAttachments() {
    if (!this.active) return;
    const picked = await pickFiles({ multiple: true, directory: false });
    for (const p of Array.isArray(picked) ? picked : picked ? [picked] : []) this.addAttachment(String(p));
    this.composer.focus();
  }

  /** A pasted image (a screenshot) becomes a draft file; pasted files attach. */
  private async paste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || !this.active) return;
    e.preventDefault();
    const chat = this.active.chat;
    for (const f of files) {
      const ext = (f.type.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8);
      const path = await writeDraft(`paste.${ext}`, new Uint8Array(await f.arrayBuffer())).catch(() => "");
      if (path && this.active?.chat === chat) this.addAttachment(path);
    }
  }

  // ---------------------------------------------------------- search + new chat (:1183-1323)
  private startMode(mode: Mode) {
    this.mode = mode;
    this.hits = [];
    this.hitCursor = 0;
    this.searchEl.placeholder = mode === "new" ? "To: name, number or email" : "Search  ( / )";
    if (mode === "list") { this.searchEl.value = ""; this.renderList(); return; }
    if (this.peeking) { this.peeking = false; }
    this.searchEl.focus();
    this.scheduleSearch();
  }

  private scheduleSearch() {
    const q = this.searchEl.value.trim();
    if (this.mode === "list") return;
    if (this.mode === "search") this.hits = this.localHits(q);
    this.renderList();
    clearTimeout(this.searchTimer);
    if (!q) return;
    this.searchTimer = window.setTimeout(() => void this.runSearch(q), 150);
  }

  private fuzzy(q: string, s: string): number {
    const a = q.toLowerCase(), b = s.toLowerCase();
    const i = b.indexOf(a);
    if (i >= 0) return 1000 + (i === 0 ? 100 : 0) - Math.min(b.length, 100);
    let score = 0, pos = 0, run = 0;
    for (const ch of a) {
      const j = b.indexOf(ch, pos);
      if (j < 0) return -1;
      run = j === pos ? run + 1 : 0;
      score += 1 + run * 5 + (j === 0 || b[j - 1] === " " ? 20 : 0);
      pos = j + 1;
    }
    return score;
  }

  private localHits(q: string): Hit[] {
    if (!q) return [];
    return this.threads
      .map((t) => ({ t, s: Math.max(this.fuzzy(q, displayName(t)), this.fuzzy(q, t.handle || "")) }))
      .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 8)
      .map(({ t }) => ({ chat: t.chat, name: displayName(t), handle: t.handle, service: t.service, ts: t.last_ts, kind: "conversation" }));
  }

  private async runSearch(q: string) {
    const seq = ++this.searchSeq;
    const mode = this.mode;
    let hits: Hit[] = [];
    if (mode === "search") {
      const threads = this.threads.map((t) => ({ chat: t.chat, name: displayName(t), handle: t.handle, service: t.service, last_ts: t.last_ts, last_from_me: t.last_from_me, last_text: t.last_text }));
      const d = json<{ ok: boolean; results: Hit[] }>(await core("search", ["--stdin", "40"], JSON.stringify({ query: q, threads }), 30_000));
      hits = d?.ok ? d.results : this.localHits(q);
    } else if (mode === "new") {
      const recency: Record<string, string> = {};
      for (const t of this.threads) recency[t.handle || t.chat] = t.last_ts;
      const d = json<{ ok: boolean; results: { name: string; handle: string; kind: string }[] }>(await core("contact-search", [q, "--recency-stdin"], JSON.stringify(recency), 30_000));
      hits = (d?.ok ? d.results : []).map((r) => ({ chat: r.handle, handle: r.handle, name: r.name, kind: r.kind }));
    }
    if (seq !== this.searchSeq || this.mode !== mode || this.searchEl.value.trim() !== q) return;
    this.hits = hits;
    this.hitCursor = Math.min(this.hitCursor, Math.max(0, hits.length - 1));
    this.renderList();
  }

  private renderHits() {
    if (!this.hits.length) {
      if (this.searchEl.value.trim()) this.listEl.append(h("div", "hint", this.mode === "new" ? "Type a name, number or email" : "no matches"));
      return;
    }
    this.hits.forEach((hit, i) => {
      const row = h("button", "row hit" + (i === this.hitCursor ? " is-cursor" : ""));
      row.append(this.avatar(hit, 32));
      const body = h("div", "row-body");
      const top = h("div", "row-top");
      top.append(h("span", "row-name", hit.name || hit.handle || hit.chat), h("span", "row-time", hit.ts ? fmtTime(hit.ts) : hit.kind || ""));
      body.append(top);
      if (hit.kind === "message" && hit.text) body.append(h("div", "row-prev", hit.text));
      row.append(body);
      row.onclick = () => this.openHit(hit);
      this.listEl.append(row);
    });
  }

  private openHit(hit: Hit) {
    const live = this.threads.find((t) => t.chat === hit.chat) || this.threads.find((t) => t.chat === hit.handle);
    const t: Thread = live || {
      chat: hit.chat, guid: "", name: hit.name, handle: hit.handle || hit.chat, service: hit.service || "iMessage",
      last_ts: hit.ts || "", last_text: "", last_from_me: false, count: 0, unread: 0, pinned: false, pin_order: null,
    };
    this.startMode("list");
    this.openThread(t, true);
  }

  private searchKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); this.startMode("list"); this.searchEl.blur(); this.focusList(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); if (!this.hits.length) { this.searchEl.blur(); this.moveCursor(1); } else { this.hitCursor = Math.min(this.hits.length - 1, this.hitCursor + 1); this.renderList(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); this.hitCursor = Math.max(0, this.hitCursor - 1); this.renderList(); }
    else if (e.key === "Enter") { e.preventDefault(); const hit = this.hits[this.hitCursor]; if (hit) this.openHit(hit); else void this.runSearch(this.searchEl.value.trim()); }
  }

  // ---------------------------------------------------------- keyboard (:1980-2149)
  private focusList() {
    this.composer.blur();
    this.searchEl.blur();
    if (this.cursor < 0 && this.active) this.cursor = this.threads.findIndex((t) => t.chat === this.active!.chat);
    this.renderList();
  }

  private moveCursor(dy: number) {
    if (!this.threads.length) return;
    const next = this.cursor + dy;
    if (next < 0) return this.startMode("search");
    this.cursor = Math.min(this.threads.length - 1, next);
    this.renderList();
    this.listEl.querySelector(".is-cursor")?.scrollIntoView({ block: "nearest" });
    this.pinnedEl.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
    // Split view: the cursor resting on a row shows that thread without reading it.
    clearTimeout(this.peekTimer);
    this.peekTimer = window.setTimeout(() => {
      const t = this.threads[this.cursor];
      if (t && this.active?.chat !== t.chat) this.showThread(t, true);
    }, 250);
  }
  private peekTimer: number | undefined;

  private globalKey(e: KeyboardEvent) {
    const inComposer = document.activeElement === this.composer;
    const inSearch = document.activeElement === this.searchEl;
    if (e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const t = this.threads.filter((x) => x.pinned)[Number(e.key) - 1];
      if (t) { e.preventDefault(); this.openThread(t, true); }
      return;
    }
    if (inComposer || inSearch || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Escape") {
      if (this.mode !== "list") { this.startMode("list"); return; }
      void getCurrentWindow().hide();
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); this.moveCursor(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); this.moveCursor(-1); }
    else if (e.key === "Enter" || e.key === "ArrowRight") { const t = this.threads[this.cursor]; if (t) { e.preventDefault(); this.openThread(t, true); } }
    else if (e.key === "/") { e.preventDefault(); this.startMode("search"); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); this.startMode("new"); }
    else if (e.key === "r") { e.preventDefault(); this.poller.refresh(true); }
    else if (/^[1-9]$/.test(e.key)) { const t = this.threads[Number(e.key) - 1]; if (t) { e.preventDefault(); this.openThread(t, true); } }
    else if (e.key === "PageUp" || e.key === "PageDown") { e.preventDefault(); this.scroller.scrollBy({ top: (e.key === "PageUp" ? -1 : 1) * this.scroller.clientHeight * 0.9 }); }
  }

  /** Open a conversation by id (a notification click, the tray). */
  goto(chat: string) {
    const t = this.threads.find((x) => x.chat === chat || (x.aliases || []).includes(chat));
    if (t) this.openThread(t, true);
  }

  // ---------------------------------------------------------- security codes (BarWidget.qml:791-832)
  /** Held five minutes in memory, nowhere else. The toast says a code
   *  arrived; the digits only ever appear here, behind a Copy button. */
  showCode(c: SecurityCode) {
    this.code = c;
    clearTimeout(this.codeTimer);
    this.codeTimer = window.setTimeout(() => { this.code = null; this.renderCode(); }, 5 * 60_000);
    this.renderCode();
  }

  private renderCode() {
    this.codeEl.textContent = "";
    this.codeEl.hidden = !this.code;
    if (!this.code) return;
    const c = this.code;
    this.codeEl.append(h("span", "", `Security code from ${c.name || "a sender"}${c.domain ? " for " + c.domain : ""}`));
    const btn = h("button", "", "Copy code");
    btn.onclick = async () => {
      await navigator.clipboard.writeText(c.code);
      btn.textContent = "Copied";
    };
    const x = h("button", "x", "✕");
    x.onclick = () => { this.code = null; this.renderCode(); };
    this.codeEl.append(btn, x);
  }
}

export { filePath };
