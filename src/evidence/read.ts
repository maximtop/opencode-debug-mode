import { createReadStream } from "node:fs"
import { type EvidenceEvent, EvidenceEventSchema, type EvidenceFilter } from "./types.js"

export type EvidencePage = Readonly<{
  events: EvidenceEvent[]
  nextCursor: string | null
  trailingPartialLine: boolean
  invalidLines: number
}>

function matches(event: EvidenceEvent, filter: EvidenceFilter): boolean {
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false
  if (filter.runId !== undefined && event.runId !== filter.runId) return false
  if (filter.hypothesisId !== undefined && event.hypothesisId !== filter.hypothesisId) return false
  if (filter.probeId !== undefined && event.probeId !== filter.probeId) return false
  if (filter.from !== undefined && event.timestamp < filter.from) return false
  if (filter.to !== undefined && event.timestamp > filter.to) return false
  if (filter.keyword !== undefined && !JSON.stringify(event).toLowerCase().includes(filter.keyword.toLowerCase()))
    return false
  return true
}

export async function readEvidence(filename: string, filter: EvidenceFilter = {}): Promise<EvidencePage> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 100)
  const start = filter.cursor === undefined ? 0 : Number(filter.cursor)
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("Evidence cursor is invalid")

  const events: EvidenceEvent[] = []
  let invalidLines = 0
  let trailingPartialLine = false
  let buffer = Buffer.alloc(0)
  let offset = start
  let nextCursor: string | null = null
  const stream = createReadStream(filename, { start })

  try {
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      while (true) {
        const newline = buffer.indexOf(0x0a)
        if (newline < 0) break
        const line = buffer.subarray(0, newline)
        buffer = buffer.subarray(newline + 1)
        offset += newline + 1
        if (line.byteLength === 0) continue
        try {
          const event = EvidenceEventSchema.parse(JSON.parse(line.toString("utf8")))
          if (matches(event, filter)) {
            events.push(event)
            if (events.length >= limit) {
              nextCursor = String(offset)
              stream.destroy()
              return { events, nextCursor, trailingPartialLine: false, invalidLines }
            }
          }
        } catch {
          invalidLines += 1
        }
      }
    }
    trailingPartialLine = buffer.byteLength > 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  } finally {
    stream.destroy()
  }
  return { events, nextCursor, trailingPartialLine, invalidLines }
}
