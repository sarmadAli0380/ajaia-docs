import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "server/**/*.test.ts", "client/src/**/*.test.ts"],
    environment: "node",
    // PGlite boots a WASM Postgres per test file.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
