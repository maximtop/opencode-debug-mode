import { writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { LIMITS } from "../../src/core/constants.js"
import { InvestigationStore, initialInvestigationState } from "../../src/investigation/store.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("investigation checkpoint", () => {
  it("uses revision CAS and rejects raw evidence fields", () =>
    withTempProject(async ({ paths }) => {
      const store = new InvestigationStore(paths.stateFile)
      await store.create(initialInvestigationState("2026-07-13T00:00:00.000Z"))
      const state = await store.read()
      expect(state.revision).toBe(0)
      await expect(store.create(state)).rejects.toMatchObject({ code: "STATE_INVALID" })
      await expect(store.checkpoint(4, state)).rejects.toMatchObject({ code: "STALE_REVISION" })
      await expect(store.checkpoint(0, { ...state, rawLogs: ["secret"] } as never)).rejects.toMatchObject({
        code: "STATE_INVALID",
      })
      const updated = await store.checkpoint(0, { ...state, nextAction: "continue" })
      expect(updated.state).toMatchObject({ revision: 1, nextAction: "continue" })
      expect(updated.bytes).toBeGreaterThan(0)
    }))

  it("returns explicit missing, malformed, unsupported, and oversized recovery results", () =>
    withTempProject(async ({ paths }) => {
      const store = new InvestigationStore(paths.stateFile)
      await expect(store.readRecovery()).resolves.toMatchObject({ ok: false, error: { code: "STATE_MISSING" } })
      await writeFile(paths.stateFile, "not-json")
      await expect(store.readRecovery()).resolves.toMatchObject({ ok: false, error: { code: "STATE_INVALID" } })
      await writeFile(paths.stateFile, '{"schemaVersion":99}')
      await expect(store.readRecovery()).resolves.toMatchObject({
        ok: false,
        error: { code: "STATE_VERSION_UNSUPPORTED" },
      })
      await writeFile(paths.stateFile, "x".repeat(LIMITS.checkpointBytes + 1))
      await expect(store.readRecovery()).resolves.toMatchObject({ ok: false, error: { code: "STATE_INVALID" } })
    }))
})
