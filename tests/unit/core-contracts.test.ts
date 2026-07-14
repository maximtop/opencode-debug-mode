import { describe, expect, it } from "vitest"
import { DebugModeError } from "../../src/core/errors.js"
import { failure, success } from "../../src/core/result.js"
import { OpaqueIdSchema } from "../../src/core/schemas.js"
import { jsonFailure, jsonSuccess, serializeEnvelope } from "../../src/tools/common.js"

describe("core contracts", () => {
  it.each(["../escape", "/absolute", "contains.dot", "two words", ""])("rejects path-like opaque ID %j", (value) =>
    expect(OpaqueIdSchema.safeParse(value).success).toBe(false))

  it("accepts generated opaque IDs and emits stable envelopes", () => {
    expect(OpaqueIdSchema.parse("run_F7yq-2")).toBe("run_F7yq-2")
    expect(success({ revision: 2 })).toEqual({ ok: true, data: { revision: 2 }, warnings: [] })
    expect(failure("STALE_REVISION", "Expected revision 2", false)).toEqual({
      ok: false,
      error: { code: "STALE_REVISION", message: "Expected revision 2", retryable: false },
    })
    expect(success({ revision: 2 }, [{ code: "NOTICE", message: "fixture" }])).toMatchObject({
      warnings: [{ code: "NOTICE" }],
    })
    const detailed = failure("STATE_INVALID", "x".repeat(9_000), true, {
      action: "a".repeat(9_000),
      details: { revision: 2 },
    })
    expect(detailed).toMatchObject({
      error: { retryable: true, action: expect.stringMatching(/^a+$/u), details: { revision: 2 } },
    })
    if (!detailed.ok) {
      expect(detailed.error.message).toHaveLength(8_192)
      expect(detailed.error.action).toHaveLength(8_192)
    }
  })

  it("serializes safe success, expected errors, and opaque internal errors", () => {
    const error = new DebugModeError("STATE_INVALID", "invalid", true, {
      action: "retry",
      details: { revision: 1 },
    })
    expect(JSON.parse(jsonSuccess({ value: 1 }))).toMatchObject({ ok: true, data: { value: 1 } })
    expect(JSON.parse(jsonFailure(error))).toMatchObject({
      error: { code: "STATE_INVALID", action: "retry", details: { revision: 1 }, retryable: true },
    })
    expect(JSON.parse(jsonFailure(new Error("secret"), "safe fallback"))).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "safe fallback", retryable: false },
    })
    expect(serializeEnvelope(success("ok"))).toBe('{"ok":true,"data":"ok","warnings":[]}')
  })
})
