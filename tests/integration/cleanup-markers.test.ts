import { describe, expect, it } from "vitest"
import { removeOwnedProbe } from "../../src/probes/remove.js"
import { markerFileFixture } from "../helpers/factories.js"

describe("marker cleanup integration", () => {
  it("preserves dirty edits around an owned probe", async () => {
    const fixture = await markerFileFixture({ before: "// user before\n", after: "// user after\n" })
    await removeOwnedProbe(fixture.manifestProbe)
    expect(await fixture.read()).toBe("// user before\n// user after\n")
  })
})
