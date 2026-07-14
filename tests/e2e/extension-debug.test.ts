import { describe, expect, it } from "vitest"
import { runHumanReproductionFixture } from "../helpers/factories.js"

describe.each([
  { fixture: "chrome-mv3" as const, transport: "extension-content" as const },
  { fixture: "firefox-mv2" as const, transport: "extension-content" as const },
])("$fixture debug journey", ({ fixture, transport }) => {
  it("collects reproduction evidence and removes probes/helper/permissions", async () => {
    const result = await runHumanReproductionFixture({ fixture, transport })
    expect(result.preFixEvents).toBeGreaterThan(0)
    expect(result.postFixEvents).toBeGreaterThan(0)
    expect(result.manualCollectorSteps).toEqual([])
    expect(result.cleanup.status).toBe("complete")
    expect(result.remainingOwnedArtifacts).toEqual([])
    expect(result.cleanedBuild.exitCode).toBe(0)
  })
})
