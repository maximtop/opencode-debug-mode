import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { createDebugModePlugin } from "../../src/plugin.js"
import { pluginHarness } from "../helpers/factories.js"

const phases = [
  "intake",
  "hypotheses",
  "baseline",
  "instrumenting",
  "waiting_for_reproduction",
  "analyzing",
  "fixing",
  "verifying",
  "cleaning",
] as const

function parse(value: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: tool envelopes vary by phase and are asserted at their use sites.
  return JSON.parse(value as string) as { ok: boolean; data: Record<string, any> }
}

describe("resume acceptance", () => {
  it.each(phases)("restores %s state before the next action", async (phase) => {
    const tempBase = await mkdtemp(path.join(tmpdir(), "opencode-debug-resume-"))
    onTestFinished(() => rm(tempBase, { recursive: true, force: true }))
    const harness = await pluginHarness(createDebugModePlugin({ tempBase }), { activeSessions: ["session-A"] })
    const initial = parse(await harness.executeTool("debug_state_read", {})).data.state
    const completedCheck = {
      id: "check_done",
      summary: "Observed the runtime branch",
      interpretation: "The branch condition is false",
      conclusive: true,
      evidenceRefs: ["event_done"],
      completedAt: "2026-07-13T00:00:00.000Z",
    }
    expect(
      parse(
        await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: initial.revision,
          state: {
            ...initial,
            phase,
            completedChecks: [completedCheck],
            hypotheses: [
              {
                id: "hyp_A",
                rank: 1,
                statement: "Runtime branch is false",
                confirmationSignals: ["event_done"],
                eliminationSignals: ["branch is true"],
                status: "confirmed",
                evidenceRefs: ["event_done"],
              },
            ],
            nextAction: "Apply the evidence-backed fix",
          },
        }),
      ).ok,
    ).toBe(true)

    const compacted = await harness.compact()
    expect(compacted.context.join(" ")).toMatch(/call debug_state_read.*Do not repeat a conclusive check/iu)
    const resumed = parse(await harness.executeTool("debug_state_read", {})).data.state

    expect(resumed).toMatchObject({ revision: 1, phase, nextAction: "Apply the evidence-backed fix" })
    expect(resumed.completedChecks).toEqual([completedCheck])
    expect(resumed.hypotheses[0].status).toBe("confirmed")
    expect(harness.toolCalls.at(-1)).toBe("debug_state_read")
  })
})
