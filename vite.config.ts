import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(packageVersion) },
  plugins: [react()],
  base: "./",
  server: { strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 700, rollupOptions: { output: { manualChunks: { pdf: ["pdfjs-dist"] } } } },
  publicDir: false,
});
