import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    dts: false,
    sourcemap: true,
    clean: true,
    external: ["@opencode-ai/plugin"],
  },
  {
    entry: { "process-supervisor": "src/process/supervisor-entry.ts" },
    format: ["esm"],
    target: "node20",
    dts: false,
    sourcemap: true,
    clean: false,
    external: ["@opencode-ai/plugin"],
  },
])
