import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { atomicWriteJson } from "../../src/session/atomic-json.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("atomic JSON", () => {
  it("writes one complete bounded JSON value", () =>
    withTempProject(async ({ paths }) => {
      const file = `${paths.sessionDir}/atomic.json`
      const bytes = await atomicWriteJson(file, { revision: 1 }, 128)
      expect(bytes).toBe(Buffer.byteLength('{"revision":1}\n'))
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 1 })
    }))

  it("rejects a serialized value above the byte limit", () =>
    withTempProject(async ({ paths }) => {
      await expect(atomicWriteJson(`${paths.sessionDir}/large.json`, { value: "too large" }, 4)).rejects.toBeInstanceOf(
        RangeError,
      )
    }))
})
