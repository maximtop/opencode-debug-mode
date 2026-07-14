import { request } from "node:http"

export type CollectorFixture = {
  start(): Promise<{ host: "127.0.0.1" | "::1"; port: number }>
  authHeaders: Record<string, string>
}

export async function collectorRequest(
  fixture: CollectorFixture,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; json: unknown }> {
  const collector = await fixture.start()
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: collector.host, port: collector.port, path: pathname, method, headers },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let parsed: unknown
          if (text !== "") {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = undefined
            }
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: parsed })
        })
      },
    )
    outgoing.once("error", reject)
    if (body !== undefined) outgoing.write(body)
    outgoing.end()
  })
}

export function postEvents(fixture: CollectorFixture, events: unknown[]) {
  const body = JSON.stringify({ events })
  return collectorRequest(
    fixture,
    "POST",
    "/v1/events",
    { ...fixture.authHeaders, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
    body,
  )
}
