import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { readBoundedJsonBody } from "../../src/collector/body.js"
import { LIMITS } from "../../src/core/constants.js"

function request(chunks: Array<string | Buffer>, headers: Record<string, string> = {}) {
  const stream = Readable.from(chunks) as Readable & { headers: Record<string, string>; resume(): Readable }
  stream.headers = headers
  return stream as never
}

describe("bounded collector body", () => {
  it("accepts chunked JSON with a content-type parameter", async () => {
    await expect(
      readBoundedJsonBody(request(['{"events":', "[]}"], { "content-type": "application/json; charset=utf-8" })),
    ).resolves.toEqual({ events: [] })
  })

  it.each([
    [{}, 415, "UNSUPPORTED_MEDIA_TYPE"],
    [{ "content-type": "text/plain" }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    [{ "content-type": "application/json", "content-length": "invalid" }, 400, "INVALID_REQUEST"],
    [{ "content-type": "application/json", "content-length": String(LIMITS.requestBytes + 1) }, 413, "LIMIT_EXCEEDED"],
  ] as const)("rejects invalid headers %#", async (headers, status, code) => {
    await expect(readBoundedJsonBody(request(["{}"], { ...headers }))).rejects.toMatchObject({ status, code })
  })

  it("rejects malformed and streamed oversized JSON", async () => {
    await expect(readBoundedJsonBody(request(["{"], { "content-type": "application/json" }))).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    })
    await expect(
      readBoundedJsonBody(
        request([Buffer.alloc(LIMITS.requestBytes), Buffer.from("x")], { "content-type": "application/json" }),
      ),
    ).rejects.toMatchObject({ status: 413, code: "LIMIT_EXCEEDED" })
  })
})
