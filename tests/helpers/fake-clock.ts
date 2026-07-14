import type { Clock } from "../../src/core/clock.js"

export class FakeClock implements Clock {
  private current: number

  constructor(now: string) {
    this.current = new Date(now).getTime()
  }

  now(): Date {
    return new Date(this.current)
  }

  monotonicMs(): number {
    return this.current
  }

  advance(milliseconds: number): void {
    this.current += milliseconds
  }
}
