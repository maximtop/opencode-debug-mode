import { describe, expect, it, vi } from "vitest"
import { runServiceFixture } from "../helpers/factories.js"

describe("run service", () => {
  it("creates opaque pre/post runs and limits waiting to an active run", async () => {
    const service = runServiceFixture()
    const run = await service.start({ label: "pre-fix", reproduction: "npm test", waitingForUser: false })
    expect(run.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(run.status).toBe("running")
    expect(await service.require(run.id)).toEqual(run)
    expect(
      await service.bindOutcomePredicate(run.id, { kind: "exit-code", operator: "not-equals", value: 0 }),
    ).toMatchObject({ outcomePredicate: { kind: "exit-code", operator: "not-equals", value: 0 } })
    await expect(
      service.bindOutcomePredicate(run.id, { kind: "exit-code", operator: "equals", value: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    expect(
      await service.complete(run.id, "completed", {
        issueReproduced: true,
        observationSource: "deterministic",
        observation: "baseline failed",
      }),
    ).toMatchObject({
      status: "completed",
      issueReproduced: true,
      observationSource: "deterministic",
      observation: "baseline failed",
    })
    await expect(service.complete(run.id, "completed")).rejects.toMatchObject({ code: "INVALID_PHASE" })
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

  it("rejects invalid bindings and reuses the reproduced baseline predicate", async () => {
    const predicate = { kind: "exit-code" as const, operator: "not-equals" as const, value: 0 }
    const service = runServiceFixture()

    await expect(service.bindOutcomePredicate("missing", predicate)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" })
    await expect(
      service.bindOutcomePredicate("missing", { kind: "exit-code", operator: "not-equals", value: -1 }),
    ).rejects.toMatchObject({ code: "STATE_INVALID" })

    const preFix = await service.start({ label: "pre-fix", reproduction: "npm test", waitingForUser: false })
    const bound = await service.bindOutcomePredicate(preFix.id, predicate)
    await expect(service.bindOutcomePredicate(preFix.id, predicate)).resolves.toEqual(bound)
    await service.complete(preFix.id, "completed", { issueReproduced: true })
    await expect(service.bindOutcomePredicate(preFix.id, predicate)).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const unmatched = await service.start({
      label: "post-fix",
      reproduction: "npm test -- other",
      waitingForUser: false,
    })
    await expect(service.bindOutcomePredicate(unmatched.id, predicate)).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const matching = await service.start({ label: "post-fix", reproduction: " npm   test ", waitingForUser: false })
    await expect(service.bindOutcomePredicate(matching.id, predicate)).resolves.toMatchObject({
      outcomePredicate: predicate,
    })
  })
})
