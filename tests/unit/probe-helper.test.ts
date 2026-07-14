import { describe, expect, it } from "vitest"
import { TransportHelper } from "../../src/probes/helper.js"
import { createProbePlanFixture } from "../helpers/factories.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("probe transport helper", () => {
  it("creates a new exact-hash-owned helper", async () => {
    const fixture = await createProbePlanFixture({ transport: "http-web" })
    const plan = await fixture.prepare({ captures: [] })
    expect(plan.helperSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.helperBytes).toBeGreaterThan(0)
  })

  it("rejects a helper target outside the project", () =>
    withTempProject(async ({ paths }) => {
      const helper = new TransportHelper(paths.projectRoot)
      await expect(
        helper.create({
          targetPath: "../escape.mjs",
          host: "127.0.0.1",
          port: 32123,
          token: Buffer.alloc(32, 1).toString("base64url"),
          runtime: "web",
        }),
      ).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })
    }))
})
