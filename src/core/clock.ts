import { performance } from "node:perf_hooks"

export interface Clock {
  now(): Date
  monotonicMs(): number
}

export const systemClock: Clock = Object.freeze({
  now: () => new Date(),
  monotonicMs: () => performance.now(),
})
