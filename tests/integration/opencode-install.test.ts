import { describe, expect, it } from "vitest"
import { installPackedPluginAndReadConfig } from "../helpers/open-code.js"

describe("OpenCode package install", () => {
  const debugTools = [
    "debug_session_start",
    "debug_session_status",
    "debug_state_read",
    "debug_state_checkpoint",
    "debug_run_start",
    "debug_run_finish",
    "debug_process_capture",
    "debug_collector_start",
    "debug_probe_prepare",
    "debug_probe_register",
    "debug_probe_remove",
    "debug_evidence_read",
    "debug_cleanup",
  ]

  it.each(
    process.env.OPENCODE_TEST_VERSIONS?.split(",") ?? ["1.17.0", "1.18.3"],
  )("registers agent and command on OpenCode %s", async (version) => {
    const config = await installPackedPluginAndReadConfig(version)
    expect(config.agent.debug.mode).toBe("primary")
    expect(config.agent.debug.permission).toEqual({
      question: "allow",
      plan_enter: "deny",
      plan_exit: "deny",
    })
    expect(config.agent.debug.tools.question).toBe(true)
    expect(debugTools.every((name) => config.agent.debug.tools[name] === true)).toBe(true)
    expect(config.command.debug.agent).toBe("debug")
    expect(config.command.debug.template).toBe("$ARGUMENTS")
  }, 300_000)
})
