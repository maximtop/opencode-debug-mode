import type { IncomingMessage, ServerResponse } from "node:http"
import { authenticateBearer } from "./auth.js"

export type IngestHandler = (request: IncomingMessage, response: ServerResponse, origin?: string) => Promise<void>

const ERROR_MESSAGES = {
  INVALID_REQUEST: "Invalid request",
  UNAUTHORIZED: "Unauthorized",
  NOT_FOUND: "Not found",
  METHOD_NOT_ALLOWED: "Method not allowed",
  COLLECTOR_DRAINING: "Collector is draining",
} as const

function baseHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "application/json; charset=utf-8",
  }
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...baseHeaders(), ...headers })
  response.end(JSON.stringify(value))
}

function error(
  response: ServerResponse,
  status: number,
  code: keyof typeof ERROR_MESSAGES,
  retryable = false,
  headers: Record<string, string> = {},
): void {
  json(response, status, { ok: false, error: { code, message: ERROR_MESSAGES[code], retryable } }, headers)
}

function validOrigin(value: string): boolean {
  if (value.length > 2_048 || /[\s\r\n]/u.test(value)) return false
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+$/u.test(value)
}

function preflight(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin
  const requestedMethod = request.headers["access-control-request-method"]
  const rawHeaders = request.headers["access-control-request-headers"] ?? ""
  if (
    origin === undefined ||
    !validOrigin(origin) ||
    requestedMethod !== "POST" ||
    typeof rawHeaders !== "string" ||
    rawHeaders.length > 256
  ) {
    error(response, 400, "INVALID_REQUEST")
    return
  }
  const requestedHeaders = rawHeaders
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (requestedHeaders.some((value) => value !== "authorization" && value !== "content-type")) {
    error(response, 400, "INVALID_REQUEST")
    return
  }
  response.writeHead(204, {
    ...baseHeaders(),
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  })
  response.end()
}

export function createCollectorRouter(options: {
  token: string
  ingest?: IngestHandler
  onAuthenticated?: () => void | Promise<void>
}) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    status: () => "ready" | "draining",
  ): Promise<void> => {
    const rawUrl = request.url ?? ""
    let url: URL
    try {
      url = new URL(rawUrl, "http://loopback.invalid")
    } catch {
      error(response, 404, "NOT_FOUND")
      return
    }
    if (url.search !== "") {
      error(response, 404, "NOT_FOUND")
      return
    }
    const pathname = url.pathname
    if (request.method === "OPTIONS") {
      if (pathname === "/v1/events") preflight(request, response)
      else error(response, 404, "NOT_FOUND")
      return
    }

    const authorization = Array.isArray(request.headers.authorization) ? undefined : request.headers.authorization
    if (!authenticateBearer(authorization, options.token)) {
      error(response, 401, "UNAUTHORIZED")
      return
    }
    await options.onAuthenticated?.()

    if (pathname === "/v1/health") {
      if (request.method !== "GET") {
        error(response, 405, "METHOD_NOT_ALLOWED", false, { Allow: "GET" })
        return
      }
      json(response, 200, { ok: true, status: status() })
      return
    }
    if (pathname === "/v1/events") {
      if (request.method !== "POST") {
        error(response, 405, "METHOD_NOT_ALLOWED", false, { Allow: "OPTIONS, POST" })
        return
      }
      if (status() === "draining") {
        error(response, 429, "COLLECTOR_DRAINING", true)
        return
      }
      if (options.ingest === undefined) {
        error(response, 400, "INVALID_REQUEST")
        return
      }
      const origin = request.headers.origin
      await options.ingest(request, response, typeof origin === "string" && validOrigin(origin) ? origin : undefined)
      return
    }
    error(response, 404, "NOT_FOUND")
  }
}

export function writeCollectorJson(response: ServerResponse, status: number, value: unknown, origin?: string): void {
  json(response, status, value, origin === undefined ? {} : { "Access-Control-Allow-Origin": origin, Vary: "Origin" })
}
