import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("debug agent policy", () => {
  it("requires state-first, hypotheses-before-fix, three-iteration, verification, and cleanup", async () => {
    const prompt = await readFile("assets/debug-agent.md", "utf8")
    expect(prompt).toContain("Call `debug_state_read` before the first action of every resumed turn")
    expect(prompt).toContain("two to four ranked falsifiable hypotheses")
    expect(prompt).toContain("Never claim runtime confirmation from static analysis alone")
    expect(prompt).toContain("Stop after three no-signal iterations")
    expect(prompt).toContain("Always call `debug_cleanup`")
    expect(prompt).toContain("Do not ask the developer to inspect the collector")
  })
})
