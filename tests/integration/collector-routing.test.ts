import { describe, expect, it } from "vitest"
import { createCollectorRouter } from "../../src/collector/router.js"
import { CollectorServer } from "../../src/collector/server.js"
import { createCollectorFixture } from "../helpers/factories.js"
import { collectorRequest } from "../helpers/http-client.js"

describe("collector routing", () => {
  it("allows only ingestion preflight and authenticated minimal health", async () => {
    const fixture = await createCollectorFixture()
    const preflight = await collectorRequest(fixture, "OPTIONS", "/v1/events", {
      Origin: "moz-extension://fixture",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined()
    expect((await collectorRequest(fixture, "GET", "/v1/health")).status).toBe(401)
    const health = await collectorRequest(fixture, "GET", "/v1/health", fixture.authHeaders)
    expect(health.json).toEqual({ ok: true, status: "ready" })
    expect((await collectorRequest(fixture, "GET", "/v1/events", fixture.authHeaders)).status).toBe(405)
  })

  it("rejects malformed preflights, queries, unknown paths, and wrong methods", async () => {
    const fixture = await createCollectorFixture()
    expect((await collectorRequest(fixture, "OPTIONS", "/v1/events")).status).toBe(400)
    expect(
      (
        await collectorRequest(fixture, "OPTIONS", "/v1/events", {
          Origin: "https://example.test",
          "Access-Control-Request-Method": "GET",
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await collectorRequest(fixture, "OPTIONS", "/v1/events", {
          Origin: "https://example.test",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "x-forbidden",
        })
      ).status,
    ).toBe(400)
    expect((await collectorRequest(fixture, "OPTIONS", "/unknown")).status).toBe(404)
    expect((await collectorRequest(fixture, "GET", "/v1/health?details=1", fixture.authHeaders)).status).toBe(404)
    expect((await collectorRequest(fixture, "POST", "/v1/health", fixture.authHeaders)).status).toBe(405)
    expect((await collectorRequest(fixture, "GET", "/unknown", fixture.authHeaders)).status).toBe(404)
    expect(
      (
        await collectorRequest(fixture, "OPTIONS", "/v1/events", {
          Origin: `https://${"x".repeat(2_100)}.test`,
          "Access-Control-Request-Method": "POST",
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await collectorRequest(fixture, "OPTIONS", "/v1/events", {
          Origin: "https://example.test",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "a".repeat(300),
        })
      ).status,
    ).toBe(400)
  })

  it("fails closed when ingestion is absent or the collector is draining", async () => {
    const token = Buffer.alloc(32, 5).toString("base64url")
    const server = new CollectorServer(createCollectorRouter({ token }))
    const handle = await server.start()
    const fixture = {
      start: async () => handle,
      authHeaders: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    }
    expect((await collectorRequest(fixture, "POST", "/v1/events", fixture.authHeaders, '{"events":[]}')).status).toBe(
      400,
    )
    const internal = server as unknown as { state: "ready" | "draining" }
    internal.state = "draining"
    expect((await collectorRequest(fixture, "POST", "/v1/events", fixture.authHeaders, '{"events":[]}')).status).toBe(
      429,
    )
    await server.close()
  })
})
