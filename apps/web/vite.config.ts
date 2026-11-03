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
    // kibble 관례: 테스트는 shared 소스를 직접 본다 (dist 빌드 없이도 동작)
    alias: {
      "@chirp/shared": path.resolve(root, "../../packages/shared/src/index.ts"),
    },
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
