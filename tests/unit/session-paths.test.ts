import { symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createSessionPaths, isContained } from "../../src/session/paths.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("session isolation", () => {
  it("uses a random temp directory rather than a supplied identifier", () =>
    withTempProject(async ({ root, tempBase }) => {
      const paths = await createSessionPaths(tempBase, root)
      expect(paths.sessionDir.startsWith(`${tempBase}/session-`)).toBe(true)
      expect(paths.sessionDir).not.toContain("../runtime-label")
      expect(isContained(tempBase, paths.sessionDir)).toBe(true)
    }))

  it("creates a missing base and rejects file or symlink bases", () =>
    withTempProject(async ({ root, tempBase }) => {
      const missing = path.join(root, "new-session-base")
      await expect(createSessionPaths(missing, root)).resolves.toMatchObject({ baseDir: missing })

      const fileBase = path.join(root, "base-file")
      await writeFile(fileBase, "not a directory")
      await expect(createSessionPaths(fileBase, root)).rejects.toThrow("must be a directory")

      const linkBase = path.join(root, "base-link")
      await symlink(tempBase, linkBase)
      await expect(createSessionPaths(linkBase, root)).rejects.toThrow("must not be a symbolic link")
    }))

  it("rejects equal, parent, and sibling containment boundaries", () => {
    expect(isContained("/workspace/project", "/workspace/project")).toBe(false)
    expect(isContained("/workspace/project", "/workspace")).toBe(false)
    expect(isContained("/workspace/project", "/workspace/other")).toBe(false)
  })
})
