import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

const target = process.env.CHIRP_DEV_API ?? "http://localhost:80";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": target,
      "/health": target,
    },
  },
  build: { outDir: "dist", sourcemap: false },
  test: {
    // Same as kibble: tests import the shared sources directly (works without a dist build)
    alias: {
      "@chirp/shared": path.resolve(root, "../../packages/shared/src/index.ts"),
    },
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
