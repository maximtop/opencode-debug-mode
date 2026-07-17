import { z } from "zod"

export const OutcomePredicateSchema = z
  .object({
    kind: z.literal("exit-code"),
    operator: z.enum(["equals", "not-equals"]),
    value: z.number().int().min(0).max(255),
  })
  .strict()

export type OutcomePredicate = z.infer<typeof OutcomePredicateSchema>

export function sameOutcomePredicate(left: OutcomePredicate, right: OutcomePredicate): boolean {
  return left.kind === right.kind && left.operator === right.operator && left.value === right.value
}

export function evaluateOutcomePredicate(
  predicate: OutcomePredicate,
  result: { exitCode: number | null; timedOut: boolean },
): boolean | null {
  if (result.timedOut || result.exitCode === null) return null
  return predicate.operator === "equals" ? result.exitCode === predicate.value : result.exitCode !== predicate.value
}
