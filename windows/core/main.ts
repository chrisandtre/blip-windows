// blip-core.exe: every core script in one Bun-compiled executable, so a
// Windows install needs neither Bun nor a checkout.
//
//   blip-core.exe collector --deep     ==  bun collector.ts --deep
//
// Each script decides it is the entry point with `if (import.meta.main)`. In
// one bundle that is true for none of them, so build.ts rewrites it per file
// to `globalThis.__blipMain === "<name>"`; this dispatcher sets the name and
// the argv the script expects, then loads it. The scripts themselves are
// unchanged.

const scripts: Record<string, () => Promise<unknown>> = {
  "collector": () => import("../../collector.ts"),
  "thread": () => import("../../thread.ts"),
  "send-file": () => import("../../send-file.ts"),
  "fetch": () => import("../../fetch.ts"),
  "avatar": () => import("../../avatar.ts"),
  "search": () => import("../../search.ts"),
  "linkpreview": () => import("../../linkpreview.ts"),
  "contact-search": () => import("../../contact-search.ts"),
  "contact-review": () => import("../../contact-review.ts"),
  "contact-details": () => import("../../contact-details.ts"),
  "contact-save": () => import("../../contact-save.ts"),
  "contact-vcard": () => import("../../contact-vcard.ts"),
  "spellcheck": () => import("../../spellcheck.ts"),
};

// A compiled executable's argv is [exe, embedded entry, ...args].
const [exe, , name = "", ...rest] = process.argv;
const load = scripts[name];
if (!load) {
  console.error(`usage: blip-core <${Object.keys(scripts).join("|")}> [args...]`);
  process.exit(64);
}
(globalThis as { __blipMain?: string }).__blipMain = name;
process.argv = [exe!, `${name}.ts`, ...rest];
await load();
