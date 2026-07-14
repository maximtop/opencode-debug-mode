import { createHash } from "node:crypto"
import { realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { CleanupService } from "../../src/cleanup/service.js"
import { createCleanupFixture } from "../helpers/factories.js"

describe("cleanup service", () => {
  it("continues after a marker failure and deletes every unambiguous resource", async () => {
    const fixture = await createCleanupFixture({ changedMarker: true, activeCollector: true, activeProcess: true })
    const result = await fixture.cleanup.run({ reason: "completed", finalReport: fixture.finalReport })
    expect(result.resources.collector.status).toBe("success")
    expect(result.resources.processes[0]?.status).toBe("success")
    expect(result.resources.probes[0]?.status).toBe("failed")
    expect(result.status).toBe("partial")
    expect(fixture.removeSecret).toHaveBeenCalled()
  })

  it("returns the finalized retained bundle location", async () => {
    const fixture = await createCleanupFixture({ keepArtifacts: true })
    const result = await fixture.cleanup.run({ reason: "completed", finalReport: fixture.finalReport })

    expect(result.retainedArtifactLocation, JSON.stringify(result, null, 2)).toBeDefined()
    expect(result.status).toBe("complete")
    expect(path.dirname(result.retainedArtifactLocation ?? "")).toBe(await realpath(fixture.retentionDestination))
  })

  it("reports unavailable or failing runtimes while continuing cleanup", async () => {
    const unavailable = await createCleanupFixture({ activeCollector: true, activeProcess: true })
    const noRuntime = new CleanupService(unavailable.session)
    const partial = await noRuntime.run({ reason: "interrupted", finalReport: unavailable.finalReport })
    expect(partial.resources.collector).toEqual({ status: "failed", reason: "collector-runtime-unavailable" })
    expect(partial.resources.processes[0]).toEqual({ status: "already-clean" })
    expect(partial.status).toBe("partial")

    const failing = await createCleanupFixture({ activeCollector: true, activeProcess: true })
    const service = new CleanupService(failing.session, {
      collector: { close: vi.fn().mockRejectedValue(new Error("close")) },
      terminateProcess: vi.fn().mockRejectedValue(new Error("terminate")),
      removeSecret: vi.fn().mockRejectedValue(new Error("secret")),
    })
    const failed = await service.run({ reason: "interrupted", finalReport: failing.finalReport })
    expect(failed.resources.collector.reason).toBe("collector-close-failed")
    expect(failed.resources.processes[0]?.reason).toBe("process-termination-failed")
    expect(failed.resources.secret.reason).toBe("secret-removal-failed")
  })

  it("removes only hash-matching owned files and executes clean checks", async () => {
    const fixture = await createCleanupFixture({})
    const matching = path.join(fixture.projectRoot, "owned-helper.mjs")
    const changed = path.join(fixture.projectRoot, "changed-helper.mjs")
    const content = Buffer.from("export {}\n")
    await Promise.all([writeFile(matching, content), writeFile(changed, "user edit\n")])
    const manifest = await fixture.session.manifestStore.read()
    await fixture.session.manifestStore.update(manifest.revision, (value) => ({
      ...value,
      ownedFiles: [
        {
          path: matching,
          kind: "transport-helper",
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        },
        {
          path: changed,
          kind: "transport-helper",
          sha256: "a".repeat(64),
          bytes: 1,
        },
        {
          path: path.join(fixture.projectRoot, "already-removed.mjs"),
          kind: "transport-helper",
          sha256: "b".repeat(64),
          bytes: 1,
        },
      ],
    }))
    const result = await fixture.cleanup.run({
      reason: "completed",
      finalReport: fixture.finalReport,
      cleanCheck: {
        executable: process.execPath,
        args: ["--check", fixture.sourceFile],
        cwd: fixture.projectRoot,
        timeoutMs: 2_000,
      },
    })
    expect(result.resources.files.map((item) => item.status)).toEqual(["success", "failed", "already-clean"])
    expect(result.cleanCheck).toMatchObject({ exitCode: 0, timedOut: false })
    expect(result.status).toBe("partial")

    const errorCheck = await createCleanupFixture({})
    const errored = await errorCheck.cleanup.run({
      reason: "completed",
      finalReport: errorCheck.finalReport,
      cleanCheck: {
        executable: path.join(errorCheck.projectRoot, "missing-executable"),
        args: [],
        cwd: errorCheck.projectRoot,
        timeoutMs: 100,
      },
    })
    expect(errored.cleanCheck).toMatchObject({ exitCode: null, timedOut: false })
  })

  it("returns the same result for concurrent and repeated cleanup calls", async () => {
    const fixture = await createCleanupFixture({})
    const [first, second] = await Promise.all([
      fixture.cleanup.run({ reason: "completed", finalReport: fixture.finalReport }),
      fixture.cleanup.run({ reason: "different", finalReport: fixture.finalReport }),
    ])
    expect(second).toBe(first)
    expect(await fixture.cleanup.run({ reason: "later", finalReport: fixture.finalReport })).toBe(first)
  })

  it("terminates a timed-out clean check without delaying cleanup", async () => {
    const fixture = await createCleanupFixture({})
    const result = await fixture.cleanup.run({
      reason: "completed",
      finalReport: fixture.finalReport,
      cleanCheck: {
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: fixture.projectRoot,
        timeoutMs: 20,
      },
    })
    expect(result.cleanCheck).toMatchObject({ timedOut: true })
  })
})
