import { readFile, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { createInitialManifest, ManifestStore } from "../../src/session/manifest-store.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("manifest store", () => {
  it("increments revisions and never serializes a token", () =>
    withTempProject(async ({ paths }) => {
      const store = new ManifestStore(paths.manifestFile)
      await store.create(
        createInitialManifest({
          sessionId: "session_A",
          trustedSessionHash: "a".repeat(64),
          projectRoot: paths.projectRoot,
          sessionDir: paths.sessionDir,
          now: "2026-07-13T00:00:00.000Z",
        }),
      )
      await expect(
        store.create(
          createInitialManifest({
            sessionId: "session_A",
            trustedSessionHash: "a".repeat(64),
            projectRoot: paths.projectRoot,
            sessionDir: paths.sessionDir,
            now: "2026-07-13T00:00:00.000Z",
          }),
        ),
      ).rejects.toMatchObject({ code: "SESSION_EXISTS" })
      const updated = await store.update(0, (value) => ({ ...value, status: "cleaning" }))
      expect(updated.revision).toBe(1)
      await expect(store.update(0, (value) => value)).rejects.toMatchObject({ code: "STALE_REVISION" })
      await Promise.all([
        store.modify((value) => ({ ...value, status: "partial" })),
        store.modify((value) => ({
          ...value,
          counters: { ...value.counters, accepted: value.counters.accepted + 1 },
        })),
      ])
      expect(await store.read()).toMatchObject({ revision: 3, status: "partial", counters: { accepted: 1 } })
      const raw = await readFile(paths.manifestFile, "utf8")
      expect(raw).not.toMatch(/token|bearer|secretValue/i)

      await writeFile(paths.manifestFile, "x".repeat(1024 * 1024 + 1))
      await expect(store.read()).rejects.toThrow("byte limit")
    }))
})
