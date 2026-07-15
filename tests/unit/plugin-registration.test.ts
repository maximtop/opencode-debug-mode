import { describe, expect, it } from "vitest"
import { pluginHarness } from "../helpers/factories.js"

describe("OpenCode plugin", () => {
  it("registers one debug agent and routing-only command", async () => {
    const harness = await pluginHarness()
    const config = await harness.applyConfig({})
    expect(config.agent?.debug).toMatchObject({ mode: "primary" })
    expect(config.agent?.debug?.permission).toEqual({ question: "allow" })
    expect(config.agent?.debug?.prompt).toContain("Hypothesis-driven runtime debugging")
    expect(config.command?.debug).toEqual({
      description: "Start hypothesis-driven runtime debugging",
      agent: "debug",
      template: "$ARGUMENTS",
    })
    expect(config.command?.debug?.template).not.toContain("hypothesis")
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
