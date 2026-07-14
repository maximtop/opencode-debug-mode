import { z } from "zod"

const MAX_MESSAGE_BYTES = 64 * 1024
const BoundedString = z.string().max(8_192)

const StartMessageSchema = z
  .object({
    type: z.literal("start"),
    executable: BoundedString.min(1),
    args: z.array(BoundedString).max(256),
    cwd: BoundedString.min(1),
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), BoundedString)
      .refine((value) => Object.keys(value).length <= 256),
    timeoutMs: z.number().int().min(1).max(300_000),
    ownerNonce: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()

const TerminateMessageSchema = z.object({ type: z.literal("terminate"), reason: BoundedString }).strict()

export const ParentMessageSchema = z.discriminatedUnion("type", [StartMessageSchema, TerminateMessageSchema])

export const ChildMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("started"), targetPid: z.number().int().positive() }).strict(),
  z
    .object({
      type: z.literal("result"),
      targetPid: z.number().int().positive(),
      exitCode: z.number().int().nullable(),
      signal: z.string().max(64).nullable(),
      timedOut: z.boolean(),
      termination: z
        .object({
          graceful: z.boolean(),
          forced: z.boolean(),
          remaining: z.boolean(),
          durationMs: z.number().nonnegative(),
          errors: z.array(z.string().max(256)).max(20),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("failure"), code: z.string().max(128), message: z.string().max(512) }).strict(),
])

export type ParentMessage = z.infer<typeof ParentMessageSchema>
export type ChildMessage = z.infer<typeof ChildMessageSchema>

function assertSize(value: unknown): void {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error("IPC message is not serializable")
  }
  if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) throw new Error("IPC message exceeds 64 KiB")
}

export function parseParentMessage(value: unknown): ParentMessage {
  assertSize(value)
  return ParentMessageSchema.parse(value)
}

export function parseChildMessage(value: unknown): ChildMessage {
  assertSize(value)
  return ChildMessageSchema.parse(value)
}
