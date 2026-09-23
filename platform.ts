// What the POSIX file-safety checks mean on Windows. On Linux every helper
// returns exactly what the inline code it replaced did, byte for byte.
//
// Linux: private files are reached through /proc/self/fd (so a swapped path
// cannot redirect a write) and must be owned by the current uid with no
// group/other bits. Windows has neither /proc nor uids: fstat reports uid 0
// and mode 0666 for everything, and O_NOFOLLOW/O_DIRECTORY do not exist. There
// the checks reduce to "is it the right kind of thing" plus an lstat that
// refuses links (O_NOFOLLOW's job), and the protection is where the files
// live: Blip's Windows home (%LOCALAPPDATA%\Blip) inherits a profile ACL that
// admits only the user, SYSTEM and Administrators.
import { closeSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

const pinned = new Map<number, string>();

/** Windows' stand-in for O_NOFOLLOW: refuse a symlink or junction (lstat
 *  reports both as links), with the ELOOP Linux gives. A path that does not
 *  exist yet is fine: it is about to be created. */
function refuseLink(path: string) {
  let link = false;
  try { link = lstatSync(path).isSymbolicLink(); } catch { /* absent */ }
  if (link) throw Object.assign(new Error(`refusing a link: ${path}`), { code: "ELOOP" });
}

/** Remember the path a directory fd was opened from, so fdPath works without
 *  /proc, and refuse it if that path is a link. Returns the fd, so it wraps an
 *  open in place. No-op on Linux (O_NOFOLLOW already refused links there). */
export function pinFd(fd: number, path: string): number {
  if (!IS_WINDOWS) return fd;
  try { refuseLink(path); } catch (e) { closeSync(fd); throw e; }
  pinned.set(fd, path);
  return fd;
}

/** `/proc/self/fd/<fd>[/<name>…]` on Linux; the remembered path on Windows,
 *  whose last component must not be a link (as O_NOFOLLOW would insist). */
export function fdPath(fd: number, ...names: string[]): string {
  if (!IS_WINDOWS) return [`/proc/self/fd/${fd}`, ...names].join("/");
  const base = pinned.get(fd);
  if (base === undefined) throw new Error("descriptor was not pinned");
  const path = join(base, ...names);
  if (names.length) refuseLink(path);
  return path;
}

/** The current uid; on Windows the 0 that fstat reports for every file. */
export function currentUid(): number {
  if (typeof process.getuid === "function") return process.getuid();
  return IS_WINDOWS ? 0 : -1;
}

/** No group/other permission bits. Always true on Windows (see above). */
export function isPrivateMode(mode: number): boolean {
  return IS_WINDOWS || (mode & 0o077) === 0;
}

/** Windows: tag a file that came from someone else's message as downloaded
 *  from the internet (the Zone.Identifier stream a browser writes), so
 *  Office, Acrobat and Edge open it in Protected View. No-op elsewhere; a
 *  filesystem without streams (FAT) just keeps the file untagged. */
export function markFromInternet(path: string): void {
  if (!IS_WINDOWS) return;
  try { writeFileSync(`${path}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n"); } catch { /* no ADS here */ }
}
