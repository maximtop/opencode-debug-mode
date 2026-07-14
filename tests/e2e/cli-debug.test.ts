import { describe, expect, it } from "vitest"
import { runCliDebugFixture } from "../helpers/factories.js"

describe("CLI debug journey", () => {
  it("finds the membership cause, verifies the fix, and cleans", async () => {
    const result = await runCliDebugFixture()
    expect(result.report.rootCause).toBe("Array membership used the index operator instead of value membership")
    expect(result.preFix.evidence).toMatchObject({ isVip: false, userId: "vip-42" })
    expect(result.postFix.evidence).toMatchObject({ isVip: true, userId: "vip-42" })
    expect(result.cleanup.status).toBe("complete")
    expect(await result.remainingDebugArtifacts()).toEqual([])
    expect(await result.unrelatedEdit()).toBe("preserved\n")
  })
})
