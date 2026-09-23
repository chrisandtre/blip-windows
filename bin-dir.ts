// Where the Linux-side bridge shims live: `bin_dir=` in bridge.conf, default ~/bin.
// Pure (no fs) so the QML renderer and the TypeScript spawners agree on one answer.
// Rebuild the QML module: bun build bin-dir.ts --target browser --format esm --outfile BinDir.mjs

/** The shim directory named by bridge.conf text. Parsed, never sourced:
 *  whitespace is dropped (as the shim drops it), quotes stripped, and `~`,
 *  `~/…`, `$HOME/…`, `${HOME}/…` expand to `home`. Anything that is not then a
 *  plain absolute path (no `..`, no shell characters) means the default. */
export function parseBinDir(conf: string, home: string): string {
  const fallback = home + "/bin";
  const m = /^[ \t]*bin_dir[ \t]*=[ \t]*(.*?)[ \t]*$/m.exec(String(conf || ""));
  if (!m) return fallback;
  let v = m[1]!.replace(/\s+/g, "").replace(/^(['"])(.*)\1$/, "$2");
  if (v === "~" || v === "$HOME" || v === "${HOME}") v = home;
  else {
    const pre = /^(~|\$HOME|\$\{HOME\})\//.exec(v);
    if (pre) v = home + v.slice(pre[1]!.length);
  }
  // A drive-letter home means Windows (Blip's Windows home is a path like
  // C:\Users\me\AppData\Local\Blip): accept a drive-absolute path there,
  // either slash; spaces and ~ allowed since the home itself may contain them
  // (C:\Users\John Smith, or an 8.3 short name like CHRIS_~1).
  if (/^[A-Za-z]:[\\/]/.test(home)) {
    v = v.replace(/[\\/]+$/, "");
    if (!/^[A-Za-z]:[\\/][A-Za-z0-9._ ~\\/-]*$/.test(v) || /(^|[\\/])\.\.([\\/]|$)/.test(v)) return fallback;
    return v;
  }
  v = v.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(v) || /(^|\/)\.\.(\/|$)/.test(v)) return fallback;
  return v;
}
