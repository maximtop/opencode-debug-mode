import { describe, expect, it } from "vitest"
import { createProbeTemplate } from "../../src/probes/template.js"
import { createProbePlanFixture } from "../helpers/factories.js"

describe("probe templates", () => {
  it("creates deterministic owned markers without exposing HTTP credentials", async () => {
    const fixture = await createProbePlanFixture({ transport: "http-web" })
    const plan = await fixture.prepare({ captures: [{ label: "userId", path: "user?.id" }] })
    expect(plan.markerBlock).toContain("DEBUG-START opencode-debug-mode")
    expect(plan.markerBlock).toContain(`probe=${plan.probeId}`)
    expect(JSON.stringify(plan)).not.toContain(fixture.secret)
    expect(await fixture.helperText()).toContain(fixture.secret)
    expect(plan.requiredImport).toContain(fixture.helperRelativePath)
  })

  it("rejects executable capture expressions", () => {
    expect(() =>
      createProbeTemplate({
        sessionId: "session_A",
        runId: "run_A",
        runLabel: "pre-fix",
        hypothesisId: "hyp_A",
        probeId: "probe_A",
        sourceFile: "example.ts",
        sourceLine: 1,
        message: "fixture",
        captures: [{ label: "unsafe", path: "run()" }],
        transport: "process",
        sampling: { mode: "every", n: 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSAFE_CAPTURE" }))
  })

  it("defaults extension content probes to the Chrome messaging adapter", () => {
    const result = createProbeTemplate({
      sessionId: "session_A",
      runId: "run_A",
      runLabel: "pre-fix",
      hypothesisId: "hyp_A",
      probeId: "probe_A",
      sourceFile: "content.ts",
      sourceLine: 1,
      message: "fixture",
      captures: [],
      transport: "extension-content",
      sampling: { mode: "every", n: 1 },
    })
    expect(result.markerBlock).toContain("chrome.runtime.sendMessage")
  })
})
