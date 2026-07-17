import { appendFile, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
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

  it("returns an actionable error instead of overwriting an existing source", () =>
    withTempProject(async ({ paths }) => {
      await writeFile(`${paths.projectRoot}/background.mjs`, "export const existing = true\n")
      const helper = new TransportHelper(paths.projectRoot)
      await expect(
        helper.create({
          targetPath: "background.mjs",
          host: "127.0.0.1",
          port: 32123,
          token: Buffer.alloc(32, 1).toString("base64url"),
          runtime: "extension-background",
        }),
      ).rejects.toMatchObject({
        code: "HELPER_PATH_UNSAFE",
        action: expect.stringContaining("new unused"),
      })
    }))

  it("rejects a symlinked intermediate parent before creating missing descendants", () =>
    withTempProject(async ({ root, paths }) => {
      const outside = path.join(path.dirname(root), "outside")
      const linkedParent = path.join(paths.projectRoot, "generated")
      await mkdir(outside)
      await symlink(outside, linkedParent, "dir")
      const helper = new TransportHelper(paths.projectRoot)

      await expect(
        helper.create({
          targetPath: "generated/nested/debug-transport.mjs",
          host: "127.0.0.1",
          port: 32123,
          token: Buffer.alloc(32, 1).toString("base64url"),
          runtime: "web",
        }),
      ).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })
      await expect(lstat(path.join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" })
    }))

  it("removes the helper when recording file ownership fails", () =>
    withTempProject(async ({ paths }) => {
      const target = path.join(paths.projectRoot, "debug-transport.mjs")
      const helper = new TransportHelper(paths.projectRoot, () => {
        throw new Error("manifest write failed")
      })

      await expect(
        helper.create({
          targetPath: "debug-transport.mjs",
          host: "127.0.0.1",
          port: 32123,
          token: Buffer.alloc(32, 1).toString("base64url"),
          runtime: "web",
        }),
      ).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
    }))

  it("reports an explicit residue path when failed ownership recording leaves changed helper content", () =>
    withTempProject(async ({ paths }) => {
      const target = path.join(paths.projectRoot, "debug-transport.mjs")
      const helper = new TransportHelper(paths.projectRoot, async ({ path: ownedPath }) => {
        await appendFile(ownedPath, "\n// concurrent change\n")
        throw new Error("manifest write failed")
      })

      await expect(
        helper.create({
          targetPath: "debug-transport.mjs",
          host: "127.0.0.1",
          port: 32123,
          token: Buffer.alloc(32, 1).toString("base64url"),
          runtime: "web",
        }),
      ).rejects.toMatchObject({
        code: "CLEANUP_PARTIAL",
        details: { path: target, cleanupStatus: "content-mismatch" },
        action: expect.stringContaining(target),
      })
      expect(await readFile(target, "utf8")).toContain("const authorization")
    }))
})
