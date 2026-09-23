// The Mac's clock, as seen from this PC.
//
// A pending send is stamped here and matched by thread.ts against the row the
// Mac writes, which carries the MAC's time; a match needs the two within five
// minutes. A PC whose clock is off (a dual-boot PC that reads a UTC hardware
// clock as local time is hours off) never matches, and the "Sending..." bubble
// stays. `imsg watch` prints the Mac's own `time.time()` for every chat.db
// change, so each such line tells us the offset.
let skewMs = 0;
let known = false;

/** A watch line that is a unix timestamp from the Mac. */
export function noteMacSeconds(line: string): void {
  const sec = Number(line);
  if (!Number.isInteger(sec) || sec < 1_000_000_000) return;
  skewMs = sec * 1000 - Date.now();
  known = true;
}

/** Mac time minus PC time, in ms (0 until the first watch timestamp). */
export function clockSkew(): number {
  return skewMs;
}

/** Whether the PC clock is off by more than thread.ts can tolerate. */
export function clockIsOff(): boolean {
  return known && Math.abs(skewMs) > 5 * 60_000;
}

/** "2026-09-22T18:33:12Z" in the Mac's time, the wire format marks compare against. */
export function wireStamp(pcMs = Date.now()): string {
  return new Date(pcMs + skewMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}
