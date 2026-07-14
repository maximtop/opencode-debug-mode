import { truncate } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { LIMITS } from "../../src/core/constants.js"
import { EvidenceStore } from "../../src/evidence/store.js"
import { eventFixture } from "../helpers/factories.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("NDJSON evidence store", () => {
  it("serializes concurrent appends and filters by registered fields", () =>
    withTempProject(async ({ paths }) => {
      const store = new EvidenceStore(paths.evidenceFile)
      await Promise.all([
        store.append({ ...eventFixture, eventId: "event_A", runId: "run_A", message: "alpha" }),
        store.append({ ...eventFixture, eventId: "event_B", runId: "run_B", message: "beta" }),
      ])
      const page = await store.read({ runId: "run_B", keyword: "beta", limit: 10 })
      expect(page.events.map((event) => event.eventId)).toEqual(["event_B"])
      expect(page.counters.accepted).toBe(2)
    }))

  it("restores persisted counters before accepting events after restart", () =>
    withTempProject(async ({ paths }) => {
      const first = new EvidenceStore(paths.evidenceFile)
      await first.append({ ...eventFixture, eventId: "event_before_restart" })
      const persisted = first.snapshotCounters()

      const resumed = new EvidenceStore(paths.evidenceFile, undefined, undefined, async () => persisted)
      expect((await resumed.read()).counters.accepted).toBe(1)
      await resumed.append({ ...eventFixture, eventId: "event_after_restart" })

      expect((await resumed.read()).counters.accepted).toBe(2)
    }))

  it("counts sampled, rejected, truncated, request, event-limit, and byte-limit outcomes", () =>
    withTempProject(async ({ paths }) => {
      const updates = vi.fn()
      const store = new EvidenceStore(paths.evidenceFile, updates)
      expect((await store.append(eventFixture, { sampled: true })).status).toBe("sampled")
      expect((await store.append({ ...eventFixture, schemaVersion: 99 as 1 })).status).toBe("rejected")
      expect(
        (await store.append({ ...eventFixture, eventId: "event_truncated", data: { value: "x".repeat(10_000) } }))
          .status,
      ).toBe("accepted")
      await store.countRequest()
      await store.recordRejected(2)
      expect(store.snapshotCounters()).toMatchObject({ sampled: 1, rejected: 3, truncated: 1, requests: 1 })
      expect(updates).toHaveBeenCalled()

      const atEventLimit = new EvidenceStore(paths.evidenceFile, undefined, undefined, async () => ({
        accepted: LIMITS.events,
        rejected: 0,
        sampled: 0,
        truncated: 0,
        dropped: 0,
        requests: 0,
      }))
      expect((await atEventLimit.append({ ...eventFixture, eventId: "event_over_count" })).status).toBe("dropped")

      await truncate(paths.evidenceFile, LIMITS.evidenceBytes)
      const atByteLimit = new EvidenceStore(paths.evidenceFile)
      expect((await atByteLimit.append({ ...eventFixture, eventId: "event_over_bytes" })).status).toBe("dropped")
    }))
})
