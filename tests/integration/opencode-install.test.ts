import { describe, expect, it } from "vitest"
import { installPackedPluginAndReadConfig } from "../helpers/open-code.js"

describe("OpenCode package install", () => {
  it.each(
    process.env.OPENCODE_TEST_VERSIONS?.split(",") ?? ["1.17.0", "1.18.1"],
  )("registers agent and command on OpenCode %s", async (version) => {
    const config = await installPackedPluginAndReadConfig(version)
    expect(config.agent.debug.mode).toBe("primary")
    expect(config.agent.debug.permission).toEqual({
      question: "allow",
      plan_enter: "deny",
      plan_exit: "deny",
    })
    expect(config.agent.debug.tools.question).toBe(true)
    expect(config.command.debug.agent).toBe("debug")
    expect(config.command.debug.template).toBe("$ARGUMENTS")
  }, 300_000)
})
