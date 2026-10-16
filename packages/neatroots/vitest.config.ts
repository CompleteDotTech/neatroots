import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 20000,
    // Limit simultaneous SQLite-heavy fixtures on native Windows.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
  },
});
