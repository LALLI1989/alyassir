import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests share one real PostgreSQL; run files one after another.
    fileParallelism: false,
  },
});
