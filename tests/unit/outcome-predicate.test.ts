import { describe, expect, it } from "vitest"
import { evaluateOutcomePredicate } from "../../src/run/outcome.js"

describe("deterministic outcome predicate", () => {
  it("derives issue presence only from a completed process exit code", () => {
    const predicate = { kind: "exit-code", operator: "not-equals", value: 0 } as const
    expect(evaluateOutcomePredicate(predicate, { exitCode: 1, timedOut: false })).toBe(true)
    expect(evaluateOutcomePredicate(predicate, { exitCode: 0, timedOut: false })).toBe(false)
    expect(evaluateOutcomePredicate(predicate, { exitCode: null, timedOut: false })).toBeNull()
    expect(evaluateOutcomePredicate(predicate, { exitCode: 1, timedOut: true })).toBeNull()
  })
})
