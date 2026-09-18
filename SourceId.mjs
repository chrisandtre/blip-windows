// source-id.ts
var IMESSAGE = {
  id: "imessage",
  owns: () => true,
  argv: (tool, binDir) => [`${binDir}/${tool}`]
};
var EXTRA_SOURCES = [];
function sourceFor(chat, extra = EXTRA_SOURCES) {
  const id = String(chat || "");
  for (const s of extra)
    if (s.owns(id))
      return s;
  return IMESSAGE;
}
function bridgeArgv(chat, tool, binDir, extra = EXTRA_SOURCES) {
  return sourceFor(chat, extra).argv(tool, binDir);
}
export {
  EXTRA_SOURCES,
  IMESSAGE,
  bridgeArgv,
  sourceFor
};
