import { describe, expect, it } from "vitest"
import { createCollectorFixture } from "../helpers/factories.js"
import { postEvents } from "../helpers/http-client.js"

describe("stress acceptance", () => {
  it("reconciles a maximum-size batch", async () => {
    const fixture = await createCollectorFixture({ registeredProbe: true })
    const sent = 100
    const response = await postEvents(
      fixture,
      Array.from({ length: sent }, (_, index) =>
        fixture.event({ timestamp: new Date(1_700_000_000_000 + index).toISOString() }),
      ),
    )
    const result = response.json as { accepted: number; sampled: number; dropped: number }
    const rejected = response.status === 202 ? 0 : sent
    expect(sent).toBe(result.accepted + rejected + result.sampled + result.dropped)
  })
})
