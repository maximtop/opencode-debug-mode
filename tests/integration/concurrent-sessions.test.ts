import { describe, expect, it } from "vitest"
import { projectContextFixture, registryFixture } from "../helpers/factories.js"
import { FakeClock } from "../helpers/fake-clock.js"

describe("concurrent session acceptance", () => {
  it("isolates public IDs, secrets, and manifests in one project", async () => {
    const registry = await registryFixture(new FakeClock("2026-07-13T00:00:00.000Z"))
    const first = await registry.start("concurrent-A", projectContextFixture())
    const second = await registry.start("concurrent-B", projectContextFixture())
    expect(first.publicId).not.toBe(second.publicId)
    expect(first.secret).not.toBe(second.secret)
    expect(first.paths.sessionDir).not.toBe(second.paths.sessionDir)
  })
})
