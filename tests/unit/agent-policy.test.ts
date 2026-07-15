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

  it("continues safe investigation before using the question tool", async () => {
    const prompt = await readFile("assets/debug-agent.md", "utf8")
    expect(prompt).toContain("Proceed autonomously through all safe local investigation that remains")
    expect(prompt).toContain("Temporary owned instrumentation is investigation, not a behavioral fix")
    expect(prompt).toContain(
      "Never ask the developer to choose a hypothesis, root cause, fix direction, repository, or speculative workaround",
    )
    expect(prompt).toContain('Never ask "How do you want to proceed?" while a safe scoped investigation action remains')
    expect(prompt).toContain(
      "Treat the structured `question` tool as a deliberate human checkpoint, not a progress or planning gate",
    )
    expect(prompt).toContain("Use the structured `question` tool only when")
    expect(prompt).toContain(
      "Owned temporary instrumentation must be scoped, reversible, and observation-only; it does not authorize behavioral changes",
    )
    expect(prompt).toContain(
      "Do not request human reproduction until the baseline transport, probes, and instrumentation check are ready",
    )
    expect(prompt).toContain("At a prepared pre-fix checkpoint, ask whether the issue reproduced")
    expect(prompt).toContain("At a prepared post-fix checkpoint, ask whether the same reproduction is now fixed")
    expect(prompt).toContain(
      "Every question must request an observation or required authorization, never a speculative cause or implementation choice",
    )
    expect(prompt).toContain(
      "When pre-fix reproduction required a person, require the corresponding post-fix human verification",
    )
    expect(prompt).toContain(
      "If a deterministic local check can answer the checkpoint, run it instead of asking the developer",
    )
  })
})
