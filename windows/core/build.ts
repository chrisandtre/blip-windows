// Build blip-core.exe:  bun windows/core/build.ts [outfile]
// See main.ts for why `import.meta.main` is rewritten per file.
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const outfile = resolve(process.argv[2] ?? join(root, "windows", "target", "release", "blip-core.exe"));

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "main.ts")],
  compile: { outfile },
  minify: true,
  target: "bun",
  plugins: [
    {
      name: "blip-entry",
      setup(build) {
        build.onLoad({ filter: /\.ts$/ }, async (args) => {
          let text = await Bun.file(args.path).text();
          if (resolve(args.path, "..") === root) {
            const name = basename(args.path, ".ts");
            text = text.replaceAll("import.meta.main", `(globalThis.__blipMain === ${JSON.stringify(name)})`);
          }
          return { contents: text, loader: "ts" };
        });
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}`);
