import { describe, expect, it } from "vitest"
import { pluginHarness } from "../helpers/factories.js"

describe("OpenCode plugin", () => {
  it("registers one debug agent and routing-only command", async () => {
    const harness = await pluginHarness()
    const config = await harness.applyConfig({})
    expect(config.agent?.debug).toMatchObject({ mode: "primary" })
    expect(config.agent?.debug?.permission).toMatchObject({
      "*": "ask",
      bash: "deny",
      task: "deny",
      todoread: "allow",
      todowrite: "allow",
      edit: "allow",
      question: "allow",
      debug_session_start: "allow",
      debug_cleanup: "allow",
    })
    expect(config.agent?.debug?.tools).toMatchObject({
      question: true,
      debug_session_start: true,
      debug_run_finish: true,
      debug_cleanup: true,
      bash: false,
      task: false,
    })
    expect(config.agent?.debug?.prompt).toContain("Hypothesis-driven runtime debugging")
    expect(config.command?.debug).toEqual({
      description: "Start hypothesis-driven runtime debugging",
      agent: "debug",
      template: "$ARGUMENTS",
    })
    expect(config.command?.debug?.template).not.toContain("hypothesis")
    expect(
      harness.clientLog.mock.calls.some(([entry]) =>
        /^Loaded v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? prompt=[a-f0-9]{64}$/u.test(String(entry.body.message)),
      ),
    ).toBe(true)
  })

  it("replaces conflicting debug configuration and logs both collisions", async () => {
    const harness = await pluginHarness()
    const config = await harness.applyConfig({
      agent: { debug: { description: "old", prompt: "old" } },
      command: { debug: { description: "old", template: "old" } },
    })
    expect(config.agent?.debug?.prompt).toContain("Hypothesis-driven")
    expect(config.command?.debug?.agent).toBe("debug")
    const collisionLogs = harness.clientLog.mock.calls.filter(([entry]) =>
      String(entry.body.message).startsWith("Replacing conflicting"),
    )
    expect(collisionLogs).toHaveLength(2)
  })
})
