import { DebugModeError } from "../core/errors.js"
import { failure, success, type ToolResultEnvelope } from "../core/result.js"

export function jsonSuccess<T>(value: T): string {
  return JSON.stringify(success(value))
}

export function jsonFailure(error: unknown, fallback = "Tool operation failed"): string {
  if (error instanceof DebugModeError) {
    return JSON.stringify(
      failure(error.code, error.message, error.retryable, {
        ...(error.action === undefined ? {} : { action: error.action }),
        ...(error.details === undefined ? {} : { details: error.details }),
      }),
    )
  }
  return JSON.stringify(failure("INTERNAL_ERROR", fallback, false))
}

export function serializeEnvelope<T>(value: ToolResultEnvelope<T>): string {
  return JSON.stringify(value)
}
