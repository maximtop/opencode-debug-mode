import { describe, expect, it } from "vitest"
import { runHumanReproductionFixture } from "../helpers/factories.js"

describe("web debug journey", () => {
  it("collects reproduction evidence and removes probes and helper", async () => {
    const result = await runHumanReproductionFixture({ fixture: "web", transport: "http-web" })
    expect(result.preFixEvents).toBeGreaterThan(0)
    expect(result.postFixEvents).toBeGreaterThan(0)
    expect(result.manualCollectorSteps).toEqual([])
    expect(result.cleanup.status).toBe("complete")
    expect(result.remainingOwnedArtifacts).toEqual([])
    expect(result.cleanedBuild.exitCode).toBe(0)
  })
})
