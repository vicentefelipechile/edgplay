import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "edgplay": new URL("../../packages/server/src/index.ts", import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
  },
});
