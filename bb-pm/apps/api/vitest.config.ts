import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globalSetup: ["./tests/e2e/global-setup.ts"],
    setupFiles: ["./tests/e2e/test-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    include: ["tests/**/*.spec.ts"],
  },
  resolve: {
    alias: {
      "@bb-pm/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@": path.resolve(__dirname, "src"),
    },
  },
});
