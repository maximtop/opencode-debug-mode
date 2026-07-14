import type { DebugErrorCode, SafeErrorDetail } from "./errors.js"

export type ToolWarning = Readonly<{ code: string; message: string }>

export type ToolResultEnvelope<T> =
  | { ok: true; data: T; warnings: ToolWarning[] }
  | {
      ok: false
      error: {
        code: DebugErrorCode
        message: string
        retryable: boolean
        action?: string
        details?: Record<string, SafeErrorDetail>
      }
    }

export function success<T>(data: T, warnings: ToolWarning[] = []): ToolResultEnvelope<T> {
  return { ok: true, data, warnings }
}

export function failure(
  code: DebugErrorCode,
  message: string,
  retryable: boolean,
  options: { action?: string; details?: Record<string, SafeErrorDetail> } = {},
): ToolResultEnvelope<never> {
  const error: Extract<ToolResultEnvelope<never>, { ok: false }>["error"] = {
    code,
    message: message.slice(0, 8_192),
    retryable,
  }
  if (options.action !== undefined) error.action = options.action.slice(0, 8_192)
  if (options.details !== undefined) error.details = options.details
  return { ok: false, error }
}
