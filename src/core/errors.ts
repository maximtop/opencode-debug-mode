export type DebugErrorCode =
  | "SESSION_EXISTS"
  | "DESTINATION_REQUIRED"
  | "NODE_UNSUPPORTED"
  | "STORAGE_UNAVAILABLE"
  | "NO_ACTIVE_SESSION"
  | "SESSION_OWNERSHIP_MISMATCH"
  | "STATE_MISSING"
  | "STATE_INVALID"
  | "STATE_VERSION_UNSUPPORTED"
  | "STALE_REVISION"
  | "STATE_TOO_LARGE"
  | "INVALID_PHASE"
  | "RUN_LIMIT"
  | "RUN_NOT_FOUND"
  | "PROBE_NOT_VALIDATED"
  | "COMMAND_REQUIRES_APPROVAL"
  | "PROCESS_START_FAILED"
  | "PROCESS_TIMEOUT"
  | "LOOPBACK_BIND_FAILED"
  | "COLLECTOR_EXISTS"
  | "HELPER_PATH_UNSAFE"
  | "UNSAFE_CAPTURE"
  | "UNSUPPORTED_LANGUAGE"
  | "COLLECTOR_REQUIRED"
  | "MARKER_MISSING"
  | "MARKER_MISMATCH"
  | "PERMISSION_MISMATCH"
  | "FILTER_INVALID"
  | "EVIDENCE_UNAVAILABLE"
  | "CLEANUP_PARTIAL"
  | "EXPORT_FAILED"
  | "INTERNAL_ERROR"

export type SafeErrorDetail = string | number | boolean

export class DebugModeError extends Error {
  readonly code: DebugErrorCode
  readonly retryable: boolean
  readonly action?: string
  readonly details?: Record<string, SafeErrorDetail>

  constructor(
    code: DebugErrorCode,
    message: string,
    retryable = false,
    options: { action?: string; details?: Record<string, SafeErrorDetail> } = {},
  ) {
    super(message.slice(0, 8_192))
    this.name = "DebugModeError"
    this.code = code
    this.retryable = retryable
    if (options.action !== undefined) this.action = options.action.slice(0, 8_192)
    if (options.details !== undefined) this.details = options.details
  }
}
