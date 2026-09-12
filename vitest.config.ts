import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "packages",
          include: ["packages/**/*.test.ts"],
          exclude: ["**/node_modules/**", "packages/cli/test/**"],
          testTimeout: 15_000,
        },
      },
      {
        // The tool pages' shared browser helpers. They are runtime-neutral
        // modules with no React or Next imports, so they run here rather than
        // needing a second test runner inside the documentation app.
        test: {
          name: "docs",
          include: ["apps/docs/src/**/*.test.ts"],
        },
      },
      {
        // The CLI suite spawns the built binary as a subprocess for every
        // assertion, which is far slower than an in-process test and slower
        // still on Windows. It gets its own generous budget so a slow machine
        // reports real failures instead of timeouts.
        test: {
          name: "cli",
          include: ["packages/cli/test/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      // The CLI is tested by executing its built binary in a subprocess, so
      // source coverage cannot be attributed to packages/cli/src.
      exclude: ["packages/cli/src/**"],
      reporter: ["text-summary", "html"],
      // Regression floors slightly below current coverage, not aspirations.
      thresholds: {
        branches: 70,
        functions: 90,
        lines: 85,
        statements: 85,
      },
    },
  },
});
