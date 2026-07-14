import { appendFile, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { EvidenceStore } from "../../src/evidence/store.js"
import { eventFixture } from "../helpers/factories.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("evidence reader", () => {
  it("surfaces a trailing partial line without inventing an event", () =>
    withTempProject(async ({ paths }) => {
      const store = new EvidenceStore(paths.evidenceFile)
      await store.append(eventFixture)
      await appendFile(paths.evidenceFile, '{"partial":')
      const result = await store.read({ limit: 10 })
      expect(result.events).toHaveLength(1)
      expect(result.trailingPartialLine).toBe(true)
    }))

  it("filters every supported field, paginates, and counts invalid records", () =>
    withTempProject(async ({ paths }) => {
      const store = new EvidenceStore(paths.evidenceFile)
      const second = {
        ...eventFixture,
        eventId: "event_second",
        timestamp: "2026-07-13T00:01:00.000Z",
        runId: "run_second",
        hypothesisId: "hyp_second",
        probeId: "probe_second",
        message: "Needle value",
      }
      await store.append(eventFixture)
      await appendFile(paths.evidenceFile, "not-json\n")
      await store.append(second)

      const page = await store.read({ limit: 1 })
      expect(page.events).toHaveLength(1)
      expect(page.nextCursor).not.toBeNull()
      expect((await store.read({ cursor: page.nextCursor as string })).invalidLines).toBe(1)
      expect(
        (
          await store.read({
            sessionId: second.sessionId,
            runId: second.runId,
            hypothesisId: second.hypothesisId,
            probeId: second.probeId,
            from: second.timestamp,
            to: second.timestamp,
            keyword: "needle",
          })
        ).events,
      ).toEqual([expect.objectContaining({ eventId: "event_second" })])
      expect((await store.read({ runId: "missing" })).events).toEqual([])
      await expect(store.read({ cursor: "-1" })).rejects.toThrow("cursor")

      await writeFile(paths.evidenceFile, "")
      expect((await store.read()).events).toEqual([])
    }))
})
