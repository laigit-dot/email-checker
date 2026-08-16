import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/preload/index.ts"),
      fileName: () => "index.cjs",
      formats: ["cjs"],
    },
    minify: false,
    outDir: "dist-electron/preload",
    rollupOptions: {
      external: ["electron"],
    },
    sourcemap: true,
  },
});
