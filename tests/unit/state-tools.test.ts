import { describe, expect, it, vi } from "vitest"
import { createStateReadTool } from "../../src/tools/state-tools.js"
import { toolContextFixture } from "../helpers/factories.js"

describe("debug_state_read", () => {
  it("contains unexpected storage failures behind the public envelope", async () => {
    const tool = createStateReadTool({ requireOwned: vi.fn().mockRejectedValue(new Error("secret")) } as never)
    const result = JSON.parse((await tool.execute({}, toolContextFixture())) as string)
    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Checkpoint is unavailable", retryable: false },
    })
  })
})
