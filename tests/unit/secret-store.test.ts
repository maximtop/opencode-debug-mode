import { lstat, readFile, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { createSessionPaths } from "../../src/session/paths.js"
import { SecretStore } from "../../src/session/secret-store.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("secret store", () => {
  it("stores a 256-bit token outside manifest/state files", () =>
    withTempProject(async ({ root, tempBase }) => {
      const paths = await createSessionPaths(tempBase, root)
      const store = new SecretStore(paths.secretFile)
      const token = await store.create()
      expect(Buffer.from(token, "base64url")).toHaveLength(32)
      expect(await readFile(paths.secretFile, "utf8")).toBe(token)
      if (process.platform !== "win32") expect((await lstat(paths.secretFile)).mode & 0o777).toBe(0o600)
    }))

  it("rejects malformed credentials and removes idempotently", () =>
    withTempProject(async ({ root, tempBase }) => {
      const paths = await createSessionPaths(tempBase, root)
      const store = new SecretStore(paths.secretFile)
      await writeFile(paths.secretFile, "invalid")
      await expect(store.read()).rejects.toThrow("invalid")
      expect(await store.remove()).toBe("success")
      expect(await store.remove()).toBe("already-clean")
    }))
})
