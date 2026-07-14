import { z } from "zod"

export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
export const IsoTimestampSchema = z.string().datetime({ offset: true })
export const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const RunLabelSchema = z.enum(["pre-fix", "post-fix"])

export type OpaqueId = z.infer<typeof OpaqueIdSchema>
