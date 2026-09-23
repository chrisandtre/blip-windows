// bin-dir.ts
function parseBinDir(conf, home) {
  const fallback = home + "/bin";
  const m = /^[ \t]*bin_dir[ \t]*=[ \t]*(.*?)[ \t]*$/m.exec(String(conf || ""));
  if (!m)
    return fallback;
  let v = m[1].replace(/\s+/g, "").replace(/^(['"])(.*)\1$/, "$2");
  if (v === "~" || v === "$HOME" || v === "${HOME}")
    v = home;
  else {
    const pre = /^(~|\$HOME|\$\{HOME\})\//.exec(v);
    if (pre)
      v = home + v.slice(pre[1].length);
  }
  if (/^[A-Za-z]:[\\/]/.test(home)) {
    v = v.replace(/[\\/]+$/, "");
    if (!/^[A-Za-z]:[\\/][A-Za-z0-9._ ~\\/-]*$/.test(v) || /(^|[\\/])\.\.([\\/]|$)/.test(v))
      return fallback;
    return v;
  }
  v = v.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(v) || /(^|\/)\.\.(\/|$)/.test(v))
    return fallback;
  return v;
}
export {
  parseBinDir
};
