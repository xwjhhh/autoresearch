import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
function sourceVersion() {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: new URL(".", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  try {
    return { commit: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain", "--", "src", "electron", "scripts", "tests", "package.json", "package-lock.json", "vite.config.ts", "playwright.config.mjs")) };
  } catch {
    return { commit: null, dirty: false };
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(packageVersion), __APP_SOURCE__: JSON.stringify(sourceVersion()) },
  plugins: [react()],
  base: "./",
  server: { strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 700, rollupOptions: { output: { manualChunks: { pdf: ["pdfjs-dist"] } } } },
  publicDir: false,
});
