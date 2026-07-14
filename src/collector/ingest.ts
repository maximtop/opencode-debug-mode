import { randomBytes } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"
import { LIMITS } from "../core/constants.js"
import type { EvidenceStore } from "../evidence/store.js"
import { type EventInput, EventInputSchema } from "../evidence/types.js"
import { CollectorBodyError, readBoundedJsonBody } from "./body.js"
import { writeCollectorJson } from "./router.js"

const EventBatchSchema = z.object({ events: z.array(EventInputSchema).min(1).max(LIMITS.eventsPerBatch) }).strict()

function errorBody(code: string, message: string, retryable = false) {
  return { ok: false, error: { code, message, retryable } }
}

export function createIngestHandler(options: {
  evidence: EvidenceStore
  validateEvent: (event: EventInput) => Promise<EventInput>
  sample?: (event: EventInput) => boolean | Promise<boolean>
}) {
  return async (request: IncomingMessage, response: ServerResponse, origin?: string): Promise<void> => {
    await options.evidence.countRequest()
    let body: unknown
    try {
      body = await readBoundedJsonBody(request)
    } catch (error) {
      if (error instanceof CollectorBodyError) {
        await options.evidence.recordRejected()
        writeCollectorJson(response, error.status, errorBody(error.code, error.message), origin)
        return
      }
      throw error
    }
    const parsed = EventBatchSchema.safeParse(body)
    if (!parsed.success) {
      await options.evidence.recordRejected()
      writeCollectorJson(response, 400, errorBody("INVALID_REQUEST", "Invalid event batch"), origin)
      return
    }

    const validated: EventInput[] = []
    try {
      for (const event of parsed.data.events) validated.push(await options.validateEvent(event))
    } catch {
      await options.evidence.recordRejected(parsed.data.events.length)
      writeCollectorJson(response, 400, errorBody("INVALID_REQUEST", "Event ownership is invalid"), origin)
      return
    }

    let accepted = 0
    let sampled = 0
    let dropped = 0
    for (const event of validated) {
      const result = await options.evidence.append(
        {
          ...event,
          eventId: `event_${randomBytes(16).toString("base64url")}`,
          kind: "probe",
        },
        { sampled: (await options.sample?.(event)) ?? false },
      )
      if (result.status === "accepted") accepted += 1
      else if (result.status === "sampled") sampled += 1
      else if (result.status === "dropped") dropped += 1
    }
    writeCollectorJson(response, 202, { ok: true, accepted, sampled, dropped }, origin)
  }
}
