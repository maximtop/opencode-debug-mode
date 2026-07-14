import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // This IPC entrypoint runs only in a forked Node process; its behavior is covered by the real supervisor
      // integration suite because Vitest's in-process V8 provider cannot merge that child process's counters.
      exclude: ["src/process/supervisor-entry.ts"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
})
