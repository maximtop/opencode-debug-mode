import { describe, expect, it } from "vitest"
import { LIMITS } from "../../src/core/constants.js"
import { createCollectorLifecycleFixture } from "../helpers/factories.js"

describe("collector lifecycle", () => {
  it("expires idle collection but preserves an explicit reproduction wait", async () => {
    const idle = await createCollectorLifecycleFixture()
    idle.clock.advance(LIMITS.idleMs + 1)
    await idle.tick()
    expect(idle.cleanup).toHaveBeenCalledWith("idle-expired")

    const waiting = await createCollectorLifecycleFixture({ waitingForReproduction: true })
    waiting.clock.advance(LIMITS.idleMs * 2)
    await waiting.tick()
    expect(waiting.cleanup).not.toHaveBeenCalled()
  })
})
