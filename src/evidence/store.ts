import { appendFile, stat } from "node:fs/promises"
import { z } from "zod"
import type { Clock } from "../core/clock.js"
import { systemClock } from "../core/clock.js"
import { EVENT_SCHEMA_VERSION, LIMITS } from "../core/constants.js"
import { type EvidenceCounters, EvidenceCountersSchema } from "../session/types.js"
import { readEvidence } from "./read.js"
import { sanitizeEvidenceData } from "./sanitize.js"
import { type EvidenceEvent, EvidenceEventSchema, type EvidenceFilter } from "./types.js"

const AppendEventSchema = EvidenceEventSchema.omit({ receivedAt: true, sanitization: true, data: true }).extend({
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  data: z.unknown().optional(),
})

export type EvidenceAppendInput = z.infer<typeof AppendEventSchema>
export type CounterUpdate = (counters: EvidenceCounters) => void | Promise<void>

export class EvidenceStore {
  private tail: Promise<void> = Promise.resolve()
  private currentBytes = 0
  private initialized = false
  private readonly counters: EvidenceCounters = {
    accepted: 0,
    rejected: 0,
    sampled: 0,
    truncated: 0,
    dropped: 0,
    requests: 0,
  }

  constructor(
    private readonly filename: string,
    private readonly onCounters?: CounterUpdate,
    private readonly clock: Clock = systemClock,
    private readonly loadCounters?: () => Promise<EvidenceCounters>,
  ) {}

  async append(
    input: EvidenceAppendInput,
    options: { sampled?: boolean } = {},
  ): Promise<{ status: "accepted" | "sampled" | "dropped" | "rejected"; event?: EvidenceEvent }> {
    return this.exclusive(async () => {
      await this.initialize()
      if (options.sampled === true) {
        await this.increment("sampled")
        return { status: "sampled" }
      }

      const parsed = AppendEventSchema.safeParse(input)
      if (!parsed.success) {
        await this.increment("rejected")
        return { status: "rejected" }
      }
      if (this.counters.accepted >= LIMITS.events) {
        await this.increment("dropped")
        return { status: "dropped" }
      }

      const sanitized = sanitizeEvidenceData(parsed.data.data)
      const event = EvidenceEventSchema.parse({
        ...parsed.data,
        data: sanitized.value,
        receivedAt: this.clock.now().toISOString(),
        sanitization: {
          flags: sanitized.flags,
          droppedKeys: sanitized.droppedKeys,
          storedBytes: sanitized.storedBytes,
          ...(sanitized.originalBytes === undefined ? {} : { originalBytes: sanitized.originalBytes }),
        },
      })
      const line = `${JSON.stringify(event)}\n`
      const bytes = Buffer.byteLength(line)
      if (this.currentBytes + bytes > LIMITS.evidenceBytes) {
        await this.increment("dropped")
        return { status: "dropped" }
      }

      try {
        await appendFile(this.filename, line, { encoding: "utf8", mode: 0o600 })
      } catch (error) {
        await this.increment("rejected")
        throw error
      }
      this.currentBytes += bytes
      await this.increment("accepted")
      if (sanitized.flags.includes("truncated")) await this.increment("truncated")
      return { status: "accepted", event }
    })
  }

  async read(filter: EvidenceFilter = {}) {
    await this.initialize()
    const page = await readEvidence(this.filename, filter)
    return { ...page, counters: EvidenceCountersSchema.parse(this.counters) }
  }

  async findByIds(eventIds: readonly string[]): Promise<EvidenceEvent[]> {
    const pending = new Set(eventIds)
    const found: EvidenceEvent[] = []
    let cursor: string | undefined
    while (pending.size > 0) {
      const page = await readEvidence(this.filename, {
        eventIds: [...pending],
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const event of page.events) {
        if (pending.delete(event.eventId)) found.push(event)
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    return found
  }

  snapshotCounters(): EvidenceCounters {
    return EvidenceCountersSchema.parse(this.counters)
  }

  async countRequest(): Promise<void> {
    await this.exclusive(async () => {
      await this.initialize()
      await this.increment("requests")
    })
  }

  async recordRejected(count = 1): Promise<void> {
    await this.exclusive(async () => {
      await this.initialize()
      for (let index = 0; index < count; index += 1) await this.increment("rejected")
    })
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.loadCounters !== undefined) {
      Object.assign(this.counters, EvidenceCountersSchema.parse(await this.loadCounters()))
    }
    try {
      this.currentBytes = (await stat(this.filename)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    this.initialized = true
  }

  private async increment(field: keyof EvidenceCounters): Promise<void> {
    this.counters[field] += 1
    await this.onCounters?.(EvidenceCountersSchema.parse(this.counters))
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
