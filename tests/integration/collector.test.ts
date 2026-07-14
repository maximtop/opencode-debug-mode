import { describe, expect, it } from "vitest"
import { createCollectorFixture } from "../helpers/factories.js"
import { collectorRequest, postEvents } from "../helpers/http-client.js"

describe("collector ingestion", () => {
  it("accepts a registered event and rejects cross-session IDs", async () => {
    const fixture = await createCollectorFixture({ registeredProbe: true })
    const accepted = await postEvents(fixture, [fixture.event({ data: { password: "hidden", value: 42 } })])
    expect(accepted.status).toBe(202)
    expect(accepted.json).toMatchObject({ ok: true, accepted: 1 })
    const rejected = await postEvents(fixture, [fixture.event({ sessionId: "session_other" })])
    expect(rejected.status).toBe(400)
    expect(await fixture.evidenceText()).not.toContain("hidden")
  })

  it("rejects malformed JSON, media types, and invalid batch shapes", async () => {
    const fixture = await createCollectorFixture({ registeredProbe: true })
    expect(
      (
        await collectorRequest(
          fixture,
          "POST",
          "/v1/events",
          { ...fixture.authHeaders, "Content-Type": "text/plain" },
          "{}",
        )
      ).status,
    ).toBe(415)
    expect(
      (
        await collectorRequest(
          fixture,
          "POST",
          "/v1/events",
          { ...fixture.authHeaders, "Content-Type": "application/json" },
          "{",
        )
      ).status,
    ).toBe(400)
    expect((await postEvents(fixture, [])).status).toBe(400)
    expect(
      (
        await postEvents(
          fixture,
          Array.from({ length: 101 }, () => fixture.event()),
        )
      ).status,
    ).toBe(400)
  })

  it("reports deliberately sampled events without persisting them", async () => {
    const fixture = await createCollectorFixture({ registeredProbe: true, sample: () => true })
    const response = await postEvents(fixture, [fixture.event()])
    expect(response.json).toEqual({ ok: true, accepted: 0, sampled: 1, dropped: 0 })
    expect(await fixture.evidenceText()).toBe("")
  })

  it("reports events dropped by the session limit", async () => {
    const fixture = await createCollectorFixture({ registeredProbe: true, atEventLimit: true })
    const response = await postEvents(fixture, [fixture.event()])
    expect(response.json).toEqual({ ok: true, accepted: 0, sampled: 0, dropped: 1 })
  })
})
