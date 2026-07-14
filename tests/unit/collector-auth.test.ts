import { describe, expect, it } from "vitest"
import { authenticateBearer, createCollectorCredential } from "../../src/collector/auth.js"

describe("collector bearer auth", () => {
  it("accepts only the exact token without leaking mismatch detail", () => {
    const token = Buffer.alloc(32, 7).toString("base64url")
    expect(authenticateBearer(`Bearer ${token}`, token)).toBe(true)
    expect(authenticateBearer(undefined, token)).toBe(false)
    expect(authenticateBearer("Bearer short", token)).toBe(false)
    expect(authenticateBearer(`Basic ${token}`, token)).toBe(false)
  })

  it("creates credentials through the isolated secret store", async () => {
    const store = { create: async () => Buffer.alloc(32, 4).toString("base64url") }
    await expect(createCollectorCredential(store as never)).resolves.toHaveLength(43)
  })
})
