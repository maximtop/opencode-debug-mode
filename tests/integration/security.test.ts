import { describe, expect, it } from "vitest"
import { createCollectorFixture } from "../helpers/factories.js"
import { collectorRequest, postEvents } from "../helpers/http-client.js"

describe("security acceptance", () => {
  it("rejects invalid auth and cross-session identifiers without persistence", async () => {
    const fixture = await createCollectorFixture({ registeredProbe: true })
    expect((await collectorRequest(fixture, "GET", "/v1/health", { Authorization: "Bearer invalid" })).status).toBe(401)
    expect((await postEvents(fixture, [fixture.event({ sessionId: "../other" })])).status).toBe(400)
    expect(await fixture.evidenceText()).toBe("")
  })
})
