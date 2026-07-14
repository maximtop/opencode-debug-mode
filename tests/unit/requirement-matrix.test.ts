import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("requirement matrix", () => {
  it("maps every functional requirement and success criterion", async () => {
    const matrix = await readFile(".sdd/.current/requirement-matrix.md", "utf8")
    for (let index = 1; index <= 64; index += 1) expect(matrix).toContain(`FR-${String(index).padStart(3, "0")}`)
    for (let index = 1; index <= 15; index += 1) expect(matrix).toContain(`SC-${String(index).padStart(3, "0")}`)
  })
})
