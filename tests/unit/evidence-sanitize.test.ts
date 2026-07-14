import { describe, expect, it } from "vitest"
import { sanitizeEvidenceData } from "../../src/evidence/sanitize.js"

describe("evidence sanitizer", () => {
  it("redacts secrets and bounds cycles, arrays, depth, binary, and strings", () => {
    const value: Record<string, unknown> = {
      Authorization: "Bearer abc",
      api_key: "abc",
      safe: "x".repeat(9_000),
      bytes: Buffer.from("binary"),
      typed: new Uint16Array([1, 2]),
      arrayBuffer: new ArrayBuffer(4),
      list: Array.from({ length: 200 }, (_, index) => index),
      manyKeys: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`key_${index}`, index])),
      deep: { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } },
    }
    value.self = value
    const result = sanitizeEvidenceData(value)
    expect(result.value).toMatchObject({ Authorization: "[REDACTED]", api_key: "[REDACTED]" })
    expect(JSON.stringify(result.value)).not.toContain("Bearer abc")
    expect(result.flags).toEqual(expect.arrayContaining(["redacted", "truncated", "cycle", "binary"]))
  })

  it("safely represents unsupported primitives and hostile objects", () => {
    class CustomValue {}
    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, "unreadable", {
      enumerable: true,
      get: () => {
        throw new Error("no")
      },
    })
    const value = {
      nullValue: null,
      bool: true,
      finite: 1,
      infinity: Number.POSITIVE_INFINITY,
      bigint: 1n,
      missing: undefined,
      callable: () => undefined,
      symbol: Symbol("fixture"),
      validDate: new Date("2026-07-13T00:00:00.000Z"),
      invalidDate: new Date(Number.NaN),
      expression: /secret/giu,
      error: new Error("fixture"),
      dom: { nodeType: 1, nodeName: "DIV" },
      custom: new CustomValue(),
      hostile,
    }
    const result = sanitizeEvidenceData(value)
    expect(result.flags).toContain("unsupported")
    expect(result.value).toMatchObject({
      infinity: "[Infinity]",
      bigint: "[BigInt 1]",
      missing: "[undefined]",
      invalidDate: "[Invalid Date]",
      dom: "[DOM DIV]",
      custom: "[Unsupported CustomValue]",
    })
  })
})
