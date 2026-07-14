export const PACKAGE_ID = "opencode-debug-mode" as const
export const MANIFEST_SCHEMA_VERSION = 1 as const
export const STATE_SCHEMA_VERSION = 1 as const
export const EVENT_SCHEMA_VERSION = 1 as const
export const TEMP_BASE_NAME = "opencode-debug-mode-v1" as const
export const PROCESS_EVENT_PREFIX = "__OPENCODE_DEBUG_EVENT_V1__" as const

export const LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  scalarBytes: 8 * 1024,
  events: 25_000,
  evidenceBytes: 25 * 1024 * 1024,
  checkpointBytes: 256 * 1024,
  eventsPerBatch: 100,
  idleMs: 30 * 60 * 1000,
  collectorReadyMs: 2_000,
  cleanupMs: 5_000,
  gracefulKillMs: 750,
  forcedKillMs: 1_500,
  noSignalIterations: 3,
})
