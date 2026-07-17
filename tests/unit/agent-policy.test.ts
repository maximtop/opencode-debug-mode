import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("debug agent policy", () => {
  it("keeps the autonomous evidence-to-cleanup path explicit and compact", async () => {
    const prompt = await readFile("assets/debug-agent.md", "utf8")

    expect(prompt.length).toBeLessThan(12_000)
    expect(prompt).toContain("Call `debug_session_start`, then call `debug_state_read`")
    expect(prompt).toContain("two to four ranked falsifiable hypotheses")
    expect(prompt).toContain("Use the returned `visibilityReceiptMarkdown`")
    expect(prompt).toContain("show `## Working hypotheses`")
    expect(prompt).toContain("show `## Evidence decision`")
    expect(prompt).toContain("do not make another tool call")
    expect(prompt).not.toContain("must end with only `debug_state_read({})`")
    expect(prompt).toContain("Static analysis alone is never runtime confirmation")
    expect(prompt).toContain("`## Evidence decision`")
    expect(prompt).toContain('checkpoint `phase: "fixing"`')
    expect(prompt).toContain("Remove all pre-fix probes with `debug_probe_remove` before the post-fix capture")
    expect(prompt).toContain("repeat it with `probeIds: []`")
    expect(prompt).toContain("The plugin derives and validates the final report")
    expect(prompt).toContain("Always call cleanup")
    expect(prompt).toContain("Stop after three genuinely different no-signal iterations")
  })

  it("uses questions only for prepared human observations and brackets may-fail operations", async () => {
    const prompt = await readFile("assets/debug-agent.md", "utf8")

    expect(prompt).toContain("Use `question` only for an undiscoverable blocker")
    expect(prompt).toContain("Never ask the developer to choose a hypothesis or speculative fix")
    expect(prompt).toContain("one probe immediately before the operation")
    expect(prompt).toContain("one probe on its normal continuation")
    expect(prompt).toContain("one probe in the error/early-return branch")
    expect(prompt).toContain("Apply `markerEdit` exactly as returned")
    expect(prompt).toContain("never manually edit an owned marker")
    expect(prompt).toContain("set `reproduction.requiresUser: true`")
    expect(prompt).toContain("reload the unpacked extension from `build/dev/chrome-mv3`")
    expect(prompt).toContain("invoke `question` with the returned `preparedQuestionArgs` verbatim")
    expect(prompt).toContain("**Reproduced**, **Did not reproduce**, and **Could not complete**")
    expect(prompt).toContain("**Fixed**, **Still reproduces**, and **Could not verify**")
    expect(prompt).toContain("Do not ask the developer to inspect collector internals")
  })
})
