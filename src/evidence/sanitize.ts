import { LIMITS } from "../core/constants.js"
import type { JsonValue, SanitizationFlag } from "./types.js"

const MAX_DEPTH = 6
const MAX_KEYS = 50
const MAX_ARRAY = 100
const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "access-token",
  "refresh-token",
  "api-key",
  "apikey",
  "private-key",
  "client-secret",
])

export type SanitizeResult = Readonly<{
  value: JsonValue
  flags: SanitizationFlag[]
  droppedKeys: number
  originalBytes?: number
  storedBytes: number
}>

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\s]+/g, "-")
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value
  return Buffer.from(value)
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "")
}

function estimateOriginalBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? undefined : Buffer.byteLength(serialized)
  } catch {
    return undefined
  }
}

export function sanitizeEvidenceData(input: unknown): SanitizeResult {
  const flags = new Set<SanitizationFlag>()
  const seen = new WeakSet<object>()
  let droppedKeys = 0

  const visit = (value: unknown, depth: number): JsonValue => {
    if (depth > MAX_DEPTH) {
      flags.add("truncated")
      return "[TRUNCATED: depth]"
    }
    if (value === null) return null
    if (typeof value === "string") {
      const truncated = truncateUtf8(value, LIMITS.scalarBytes)
      if (truncated !== value) flags.add("truncated")
      return truncated
    }
    if (typeof value === "boolean") return value
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value
      flags.add("unsupported")
      return `[${String(value)}]`
    }
    if (typeof value === "bigint") {
      flags.add("unsupported")
      return `[BigInt ${truncateUtf8(value.toString(), 128)}]`
    }
    if (typeof value === "undefined") {
      flags.add("unsupported")
      return "[undefined]"
    }
    if (typeof value === "function" || typeof value === "symbol") {
      flags.add("unsupported")
      return `[${typeof value}]`
    }

    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      flags.add("binary")
      const length = Buffer.isBuffer(value)
        ? value.byteLength
        : value instanceof ArrayBuffer
          ? value.byteLength
          : value.byteLength
      return `[Binary ${length} bytes]`
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString()
    if (value instanceof RegExp) {
      flags.add("unsupported")
      return truncateUtf8(value.toString(), 256)
    }
    if (value instanceof Error) {
      flags.add("unsupported")
      return { name: truncateUtf8(value.name, 128), message: truncateUtf8(value.message, LIMITS.scalarBytes) }
    }
    if (seen.has(value)) {
      flags.add("cycle")
      return "[CYCLE]"
    }
    seen.add(value)

    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY) {
        flags.add("truncated")
        droppedKeys += value.length - MAX_ARRAY
      }
      return value.slice(0, MAX_ARRAY).map((entry) => visit(entry, depth + 1))
    }

    const record = value as Record<string, unknown>
    try {
      if (typeof record.nodeType === "number" && typeof record.nodeName === "string") {
        flags.add("unsupported")
        return `[DOM ${truncateUtf8(record.nodeName, 128)}]`
      }
    } catch {
      flags.add("unsupported")
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      flags.add("unsupported")
      return `[Unsupported ${truncateUtf8(value.constructor?.name ?? "object", 128)}]`
    }

    let keys: string[]
    try {
      keys = Object.keys(record).sort()
    } catch {
      flags.add("unsupported")
      return "[Unreadable object]"
    }
    if (keys.length > MAX_KEYS) {
      flags.add("truncated")
      droppedKeys += keys.length - MAX_KEYS
      keys = keys.slice(0, MAX_KEYS)
    }

    const result: Record<string, JsonValue> = {}
    for (const key of keys) {
      if (SECRET_KEYS.has(normalizeKey(key))) {
        result[key] = "[REDACTED]"
        flags.add("redacted")
        continue
      }
      try {
        result[key] = visit(record[key], depth + 1)
      } catch {
        result[key] = "[Unreadable property]"
        flags.add("unsupported")
      }
    }
    return result
  }

  const value = visit(input, 0)
  const storedBytes = Buffer.byteLength(JSON.stringify(value))
  const originalBytes = estimateOriginalBytes(input)
  return {
    value,
    flags: [...flags].sort(),
    droppedKeys,
    ...(originalBytes === undefined ? {} : { originalBytes }),
    storedBytes,
  }
}
