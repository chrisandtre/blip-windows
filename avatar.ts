#!/usr/bin/env bun
/**
 * Blip photo fetcher — `imsg avatar <handle>` on the Mac streams the Contacts
 * thumbnail (JPEG), `imsg avatar --chat <group id>` the group's own photo; this caches it under ~/.cache/blip/avatars keyed
 * by a hash of the handle, with a negative marker so contacts without a
 * photo are not re-asked every poll. Seven-day TTL either way.
 *
 *   bun avatar.ts <handle>   → {"ok":true,"url":"file://…"} | {"ok":false,…}
 */
import { bridgeFor } from "./shim-path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isGroupChat } from "./collector";

const HOME = process.env.HOME ?? homedir();
export const AVATAR_DIR = join(process.env.XDG_CACHE_HOME ?? join(HOME, ".cache"), "blip", "avatars");
export const AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;
/** "No photo" is remembered for a DAY, not a week. A photo can appear at any
 *  time — someone sets a group picture, adds a Contacts card, or a bridge fix
 *  starts finding one that was always there (a stale `.none` from a buggy
 *  build kept Sportsball! blank even after the bridge learned to find it).
 *  Short enough to self-heal, long enough that a photoless contact is not
 *  re-asked on every poll. */
export const AVATAR_NONE_TTL_MS = 24 * 3600 * 1000;
/** How long a "no photo" marker is trusted even under `--retry`. The UI asks
 *  with --retry so a picture set minutes ago still turns up, and it used to
 *  skip the marker outright: every photoless contact (251 of 318 on gus) went
 *  back to the Mac, one ~170 ms ssh round trip each, on EVERY window open —
 *  about 45 s of photos trickling in. Fifteen minutes keeps "someone just set
 *  a picture" working and makes a reopen free. */
export const AVATAR_RETRY_MS = 15 * 60 * 1000;
/** Most handles one `--batch` run answers; the sidebar holds a few hundred. */
export const AVATAR_BATCH_MAX = 1024;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export interface AvatarResult { ok: boolean; url: string; error: string }

export function avatarKey(handle: string): string {
  return createHash("sha256").update(handle.trim().toLowerCase()).digest("hex").slice(0, 32);
}

function fresh(path: string, ttl = AVATAR_TTL_MS): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && Date.now() - st.mtimeMs < ttl;
  } catch { return false; }
}

/** A person: `imsg avatar -- <handle>` (Contacts). A group id (32-hex or
 *  chat<digits>): `imsg avatar --chat <id>`, the group's own photo from
 *  Messages (the GroupPhotoImage attachment) — never a member's face. */
export function avatarArgs(id: string): string[] {
  return isGroupChat(id) ? ["avatar", "--chat", id] : ["avatar", "--", id];
}

/** What the disk alone can say about a handle: a fresh photo, a fresh "no
 *  photo" marker, a refusal — or null when only the Mac can answer.
 *  `retry` trusts a marker for AVATAR_RETRY_MS instead of a day: a group or
 *  contact photo can appear minutes after we first asked (someone just set
 *  one), and the UI asks with it so a letter is not sticky for a day. */
export function cachedAvatar(handle: string, opts: { retry?: boolean } = {}): AvatarResult | null {
  const h = handle.trim();
  if (h === "" || h.length > 320 || /[\s\x00-\x1f]/.test(h)) return { ok: false, url: "", error: "bad handle" };
  const base = join(AVATAR_DIR, avatarKey(h));
  if (fresh(`${base}.jpg`)) return { ok: true, url: pathToFileURL(`${base}.jpg`).href, error: "" };
  if (fresh(`${base}.none`, opts.retry ? AVATAR_RETRY_MS : AVATAR_NONE_TTL_MS)) return { ok: false, url: "", error: "no photo" };
  return null;
}

export function fetchAvatar(handle: string, runner = spawnSync, opts: { retry?: boolean } = {}): AvatarResult {
  const cached = cachedAvatar(handle, opts);
  if (cached) return cached;
  const h = handle.trim();
  mkdirSync(AVATAR_DIR, { recursive: true, mode: 0o700 });
  const base = join(AVATAR_DIR, avatarKey(h));
  const file = `${base}.jpg`;
  const none = `${base}.none`;

  const bridge = bridgeFor(h, "imsg");
  const res = runner(bridge.cmd, [...bridge.args, ...avatarArgs(h)], { timeout: 20000, maxBuffer: AVATAR_MAX_BYTES + (1 << 20) });
  if (res.status === 69 || res.status === 255) return { ok: false, url: "", error: "Mac unreachable" };
  const bytes = res.stdout as Buffer;
  // Only a real image is cached; anything else (an error string, a Core Data
  // reference) becomes a negative marker instead of a broken file. GIF counts:
  // AddressBook stores a few that way and Qt renders them (#16).
  const isImage = !!bytes && bytes.length > 4 && (
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (bytes[0] === 0x89 && bytes[1] === 0x50) ||
    (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46));
  if (res.error || res.status === null || res.status === 69 || res.status === 255) {
    return { ok: false, url: "", error: "Mac unreachable" };   // transient: no negative marker
  }
  if (res.status !== 0 || !isImage || bytes.length > AVATAR_MAX_BYTES) {
    // Exclusive create, never following a symlink: "w" truncated whatever a
    // planted symlink pointed at (Astra B#5).
    try { unlinkSync(none); } catch { /* absent */ }
    const fd = openSync(none, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const now = new Date(); utimesSync(none, now, now);
    sweepStale(AVATAR_DIR, AVATAR_TTL_MS * 2);
    return { ok: false, url: "", error: "no photo" };
  }
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  try { unlinkSync(none); } catch { /* no marker, or already gone */ }
  return { ok: true, url: pathToFileURL(file).href, error: "" };
}

/** One process for a whole sidebar (`--batch`, one handle per line on stdin).
 *  Emits one JSON line per handle in two passes — everything the disk can
 *  answer, then the Mac for the rest — so cached photos arrive at once while
 *  the misses wait on ssh. Once the Mac proves unreachable the remaining misses
 *  are answered unreachable without asking: each would sit out its own 20 s
 *  timeout, and no negative marker is written for them. */
export function fetchAvatarBatch(input: string, emit: (line: string) => void, runner = spawnSync, opts: { retry?: boolean } = {}): void {
  const handles = [...new Set(input.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l !== ""))].slice(0, AVATAR_BATCH_MAX);
  const misses: string[] = [];
  for (const h of handles) {
    const hit = cachedAvatar(h, opts);
    if (hit) emit(JSON.stringify({ handle: h, ...hit }));
    else misses.push(h);
  }
  let offline = false;
  for (const h of misses) {
    let r: AvatarResult = { ok: false, url: "", error: "Mac unreachable" };
    if (!offline) {
      try { r = fetchAvatar(h, runner, opts); } catch (e) { r = { ok: false, url: "", error: String(e) }; }
      offline = r.error === "Mac unreachable";
    }
    emit(JSON.stringify({ handle: h, ...r }));
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const retry = argv.includes("--retry");
  if (argv.includes("--batch")) {
    fetchAvatarBatch(await Bun.stdin.text(), (line) => console.log(line), spawnSync, { retry });
  } else {
    const handle = argv.find((a) => a !== "--retry") ?? "";
    try {
      console.log(JSON.stringify(fetchAvatar(handle, spawnSync, { retry })));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, url: "", error: String(e) }));
    }
  }
}

/** Drop regular files in `dir` older than `maxAgeMs`. Expiry used to mean
 *  "not reused", never "removed", so the cache only ever grew (Astra B#8). */
export function sweepStale(dir: string, maxAgeMs: number, now = Date.now()): number {
  let n = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) { unlinkSync(p); n++; }
      } catch { /* vanished */ }
    }
  } catch { /* no dir yet */ }
  return n;
}
