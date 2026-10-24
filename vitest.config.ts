import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  // Resolve the tsconfig "@/*" alias so tests can import "@/lib/..." modules.
  resolve: { alias: { "@": resolve(process.cwd(), "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    // Run test files serially within a file by default; DB-backed tests use
    // unique records so parallel files are safe.
    pool: "forks",
  },
});
