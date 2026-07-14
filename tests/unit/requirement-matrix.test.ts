import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

async function readRequirementMatrix(): Promise<string> {
  const entries = await readdir(".sdd", { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => {
      if (left === ".current") return -1
      if (right === ".current") return 1
      return right.localeCompare(left)
    })

  for (const directory of directories) {
    const spec = await readFile(join(".sdd", directory, "spec.md"), "utf8").catch(() => "")
    if (!spec.startsWith("# Feature Specification: OpenCode Debug Mode")) continue

    return readFile(join(".sdd", directory, "requirement-matrix.md"), "utf8")
  }

  throw new Error("OpenCode Debug Mode SDD specification not found")
}

describe("requirement matrix", () => {
  it("maps every functional requirement and success criterion", async () => {
    const matrix = await readRequirementMatrix()
    for (let index = 1; index <= 64; index += 1) expect(matrix).toContain(`FR-${String(index).padStart(3, "0")}`)
    for (let index = 1; index <= 15; index += 1) expect(matrix).toContain(`SC-${String(index).padStart(3, "0")}`)
  })
})
