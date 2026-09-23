import { defineConfig } from "vite";
import { resolve } from "node:path";

// The UI imports the repo's QML helper modules (SendState.mjs, SourceId.mjs,
// ...) from two levels up, so the same logic drives both front ends.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: [resolve(__dirname, "../..")] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
