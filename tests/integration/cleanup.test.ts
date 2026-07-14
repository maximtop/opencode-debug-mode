import { describe, expect, it } from "vitest"
import { createCleanupFixture } from "../helpers/factories.js"

describe("cleanup integration", () => {
  it("deletes the ephemeral session by default", async () => {
    const fixture = await createCleanupFixture({ activeCollector: true, activeProcess: true })
    const result = await fixture.cleanup.run({ reason: "completed", finalReport: fixture.finalReport })
    expect(result.status).toBe("complete")
    expect(await fixture.sessionExists()).toBe(false)
  })
})
