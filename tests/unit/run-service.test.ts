import { describe, expect, it, vi } from "vitest"
import { runServiceFixture } from "../helpers/factories.js"

describe("run service", () => {
  it("creates opaque pre/post runs and limits waiting to an active run", async () => {
    const service = runServiceFixture()
    const run = await service.start({ label: "pre-fix", reproduction: "npm test", waitingForUser: false })
    expect(run.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(run.status).toBe("running")
    expect(await service.require(run.id)).toEqual(run)
    expect(await service.complete(run.id, "completed")).toMatchObject({ status: "completed" })
    await expect(service.complete("../other", "completed")).rejects.toMatchObject({ code: "RUN_NOT_FOUND" })
  })

  it("holds and releases a waiting lease and enforces the run limit", async () => {
    const release = vi.fn()
    const acquire = vi.fn().mockResolvedValue(release)
    const service = runServiceFixture(acquire)
    const waiting = await service.start({ label: "post-fix", reproduction: "x".repeat(9_000), waitingForUser: true })
    expect(waiting).toMatchObject({ label: "post-fix", status: "waiting" })
    expect(waiting.reproduction).toHaveLength(8_192)
    expect(acquire).toHaveBeenCalledWith("waiting")
    await service.complete(waiting.id, "cancelled")
    expect(release).toHaveBeenCalledOnce()

    for (let index = 1; index < 20; index += 1) {
      await service.start({ label: "pre-fix", reproduction: String(index), waitingForUser: false })
    }
    await expect(
      service.start({ label: "pre-fix", reproduction: "over limit", waitingForUser: false }),
    ).rejects.toMatchObject({ code: "RUN_LIMIT" })
  })
})
