// What the POSIX file-safety checks mean on Windows. On Linux every helper
// returns exactly what the inline code it replaced did, byte for byte.
//
// Linux: private files are reached through /proc/self/fd (so a swapped path
// cannot redirect a write) and must be owned by the current uid with no
// group/other bits. Windows has neither /proc nor uids: fstat reports uid 0
// and mode 0666 for everything, and O_NOFOLLOW/O_DIRECTORY do not exist. There
// the checks reduce to "is it the right kind of thing", and the protection is
// where the files live: Blip's Windows home (%LOCALAPPDATA%\Blip) inherits a
// profile ACL that admits only the user, SYSTEM and Administrators, and
// creating a symlink there needs a privilege a normal user does not hold.
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

const pinned = new Map<number, string>();

/** Remember the path a directory fd was opened from, so fdPath works without
 *  /proc. Returns the fd, so it wraps an open in place. No-op on Linux. */
export function pinFd(fd: number, path: string): number {
  if (IS_WINDOWS) pinned.set(fd, path);
  return fd;
}

/** `/proc/self/fd/<fd>[/<name>…]` on Linux; the remembered path on Windows. */
export function fdPath(fd: number, ...names: string[]): string {
  if (!IS_WINDOWS) return [`/proc/self/fd/${fd}`, ...names].join("/");
  const base = pinned.get(fd);
  if (base === undefined) throw new Error("descriptor was not pinned");
  return join(base, ...names);
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
