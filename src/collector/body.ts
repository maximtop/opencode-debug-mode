import type { IncomingMessage } from "node:http"
import { LIMITS } from "../core/constants.js"

export class CollectorBodyError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: "INVALID_REQUEST" | "LIMIT_EXCEEDED" | "UNSUPPORTED_MEDIA_TYPE",
  ) {
    super(code)
  }
}

export async function readBoundedJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") throw new CollectorBodyError(415, "UNSUPPORTED_MEDIA_TYPE")
  const declared = request.headers["content-length"]
  if (declared !== undefined) {
    if (!/^\d+$/u.test(declared)) throw new CollectorBodyError(400, "INVALID_REQUEST")
    if (Number(declared) > LIMITS.requestBytes) {
      request.resume()
      throw new CollectorBodyError(413, "LIMIT_EXCEEDED")
    }
  }

  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > LIMITS.requestBytes) {
      request.resume()
      throw new CollectorBodyError(413, "LIMIT_EXCEEDED")
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))
  } catch {
    throw new CollectorBodyError(400, "INVALID_REQUEST")
  }
}
