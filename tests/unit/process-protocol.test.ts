import { describe, expect, it } from "vitest"
import { parseParentMessage } from "../../src/process/protocol.js"

describe("process supervisor protocol", () => {
  it("rejects unknown and oversized messages", () => {
    expect(() => parseParentMessage({ type: "unknown" })).toThrow()
    expect(() => parseParentMessage({ type: "terminate", reason: "x".repeat(70_000) })).toThrow()
    expect(parseParentMessage({ type: "terminate", reason: "abort" })).toEqual({ type: "terminate", reason: "abort" })
  })
})
