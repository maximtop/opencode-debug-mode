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
})
