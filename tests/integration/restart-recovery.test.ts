import { describe, expect, it } from "vitest"
import { recoverOrphans } from "../../src/session/orphan-recovery.js"
import { orphanRecoveryFixture } from "../helpers/factories.js"

describe("restart recovery", () => {
  it("is idempotent for an expired owned session", async () => {
    const fixture = await orphanRecoveryFixture()
    expect((await recoverOrphans(fixture.options)).cleaned).toEqual([fixture.expiredSessionId])
    expect((await recoverOrphans(fixture.options)).cleaned).toEqual([])
  })
})
