import { createHash } from "node:crypto"
import { readFile, realpath, writeFile } from "node:fs/promises"
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

  it("cleans known runtime resources and preserves recovery data when the manifest is unavailable", async () => {
    const fixture = await createCleanupFixture({ activeCollector: true, activeProcess: true })
    const closeCollector = vi.fn().mockResolvedValue(undefined)
    const terminateProcess = vi.fn().mockResolvedValue({ status: "success" })
    const removeSecret = vi.fn(() => fixture.session.secretStore.remove())
    const service = new CleanupService(fixture.session, {
      collector: { close: closeCollector },
      terminateProcess,
      removeSecret,
    })
    const modify = vi
      .spyOn(fixture.session.manifestStore, "modify")
      .mockRejectedValue(new Error("manifest modify failed"))
    const read = vi.spyOn(fixture.session.manifestStore, "read").mockRejectedValue(new Error("manifest read failed"))

    try {
      const result = await service.run({ reason: "interrupted", finalReport: fixture.finalReport })

      expect(result.status).toBe("partial")
      expect(result.resources.collector).toEqual({ status: "success" })
      expect(closeCollector).toHaveBeenCalledOnce()
      expect(terminateProcess).not.toHaveBeenCalled()
      expect(result.resources.processes).toEqual([])
      expect(result.resources.probes).toEqual([])
      expect(result.resources.permissions).toEqual([])
      expect(result.resources.files).toEqual([
        {
          status: "failed",
          reason: "cleanup-manifest-unavailable",
          location: fixture.session.paths.manifestFile,
        },
      ])
      expect(removeSecret).toHaveBeenCalledOnce()
      expect(result.resources.secret).toEqual({ status: "success" })
      expect(result.resources.sessionDirectory).toEqual({
        status: "failed",
        reason: "cleanup-manifest-unavailable",
        location: fixture.session.paths.sessionDir,
      })
      expect(result.remainingArtifacts).toEqual([fixture.session.paths.manifestFile, fixture.session.paths.sessionDir])
      expect(await fixture.sessionExists()).toBe(true)
      expect(await readFile(fixture.sourceFile, "utf8")).toContain("DEBUG-START")
    } finally {
      modify.mockRestore()
      read.mockRestore()
    }
  })

  it.each([
    "exited",
    "timed_out",
    "cancelled",
    "terminated",
    "failed",
  ] as const)("never signals a %s process whose PID may have been reused", async (status) => {
    const fixture = await createCleanupFixture({ activeProcess: true })
    await fixture.session.manifestStore.modify((manifest) => ({
      ...manifest,
      processes: manifest.processes.map((process) => ({
        ...process,
        status,
        targetPid: 42,
        completedAt: new Date().toISOString(),
        exitCode: 0,
        signal: null,
      })),
    }))
    const terminateProcess = vi.fn().mockResolvedValue({ status: "success" })
    const result = await new CleanupService(fixture.session, { terminateProcess }).run({
      reason: "interrupted",
      finalReport: fixture.finalReport,
    })

    expect(terminateProcess).not.toHaveBeenCalled()
    expect(result.resources.processes).toEqual([{ status: "already-clean" }])
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

  it("preserves a transport helper when a related helper import cannot be removed safely", async () => {
    const fixture = await createCleanupFixture({})
    const helper = path.join(fixture.projectRoot, "debug-transport.mjs")
    const helperContent = Buffer.from("export function emit() {}\n")
    const helperSource = path.join(fixture.projectRoot, "background.js")
    const ownership =
      "opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A resource=transport-import"
    const helperImportBlock =
      `/* DEBUG-START ${ownership} */\n` +
      'import { __opencodeDebugEmit as emitProbe } from "./debug-transport.mjs"\n' +
      `/* DEBUG-END ${ownership} */`
    const changedHelperImport = helperImportBlock.replace("emitProbe", "changedEmitProbe")
    await Promise.all([
      writeFile(helper, helperContent),
      writeFile(helperSource, `const before = true\n${changedHelperImport}\n`),
    ])
    await fixture.session.manifestStore.modify((manifest) => ({
      ...manifest,
      probes: manifest.probes.map((probe) => ({
        ...probe,
        transport: "extension-background" as const,
        helperSourceFile: helperSource,
        helperImportBlock,
        helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
      })),
      ownedFiles: [
        {
          path: helper,
          kind: "transport-helper" as const,
          sha256: createHash("sha256").update(helperContent).digest("hex"),
          bytes: helperContent.byteLength,
        },
      ],
    }))

    const result = await fixture.cleanup.run({ reason: "completed", finalReport: fixture.finalReport })

    expect(result.resources.probes[0]).toMatchObject({
      status: "failed",
      reason: "helper-import-content-mismatch",
      location: helperSource,
    })
    expect(result.resources.files).toEqual([
      { status: "failed", reason: "related-probe-cleanup-failed", location: helper },
    ])
    expect(result.remainingArtifacts).toContain(helper)
    expect(await readFile(helper, "utf8")).toBe(helperContent.toString("utf8"))
    expect(await readFile(helperSource, "utf8")).toContain(changedHelperImport)
  })

  it("cleans an active probe before an already-removed sibling that shares its helper specifier", async () => {
    const fixture = await createCleanupFixture({})
    const helper = path.join(fixture.projectRoot, "debug-transport.mjs")
    const helperContent = Buffer.from("export function __opencodeDebugEmit() {}\n")
    const specifier = "./debug-transport.mjs"
    const ownedBlock = (probeId: string, body: string, resource = "") => {
      const ownership = `opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=${probeId}${resource}`
      return `/* DEBUG-START ${ownership} */\n${body}\n/* DEBUG-END ${ownership} */`
    }
    const removedMarkerBlock = ownedBlock("probe_removed", "void __opencodeDebugEmit_removed")
    const removedImportBlock = ownedBlock(
      "probe_removed",
      `import { __opencodeDebugEmit as __opencodeDebugEmit_removed } from ${JSON.stringify(specifier)}`,
      " resource=transport-import",
    )
    const activeMarkerBlock = ownedBlock("probe_active", "void __opencodeDebugEmit_active")
    const activeImportBlock = ownedBlock(
      "probe_active",
      `import { __opencodeDebugEmit as __opencodeDebugEmit_active } from ${JSON.stringify(specifier)}`,
      " resource=transport-import",
    )
    const markerLines = (block: string) => {
      const lines = block.split("\n")
      return { markerStart: lines[0] ?? "", markerEnd: lines.at(-1) ?? "" }
    }
    await Promise.all([
      writeFile(helper, helperContent),
      writeFile(fixture.sourceFile, `${activeImportBlock}\n${activeMarkerBlock}\nconst app = true\n`),
    ])
    await fixture.session.manifestStore.modify((manifest) => ({
      ...manifest,
      probes: [
        {
          id: "probe_removed",
          runId: "run_A",
          hypothesisId: "hyp_A",
          sourceFile: fixture.sourceFile,
          sourceLine: 1,
          message: "removed fixture",
          transport: "extension-background" as const,
          captures: [],
          sampling: { mode: "every" as const, n: 1 },
          status: "removed" as const,
          validationStatus: "failed" as const,
          ...markerLines(removedMarkerBlock),
          expectedBlock: removedMarkerBlock,
          expectedHash: createHash("sha256").update(removedMarkerBlock).digest("hex"),
          helperSourceFile: fixture.sourceFile,
          helperImportBlock: removedImportBlock,
          helperImportHash: createHash("sha256").update(removedImportBlock).digest("hex"),
        },
        {
          id: "probe_active",
          runId: "run_A",
          hypothesisId: "hyp_A",
          sourceFile: fixture.sourceFile,
          sourceLine: 1,
          message: "active fixture",
          transport: "extension-background" as const,
          captures: [],
          sampling: { mode: "every" as const, n: 1 },
          status: "validated" as const,
          validationStatus: "validated" as const,
          ...markerLines(activeMarkerBlock),
          expectedBlock: activeMarkerBlock,
          expectedHash: createHash("sha256").update(activeMarkerBlock).digest("hex"),
          helperSourceFile: fixture.sourceFile,
          helperImportBlock: activeImportBlock,
          helperImportHash: createHash("sha256").update(activeImportBlock).digest("hex"),
        },
      ],
      ownedFiles: [
        {
          path: helper,
          kind: "transport-helper" as const,
          sha256: createHash("sha256").update(helperContent).digest("hex"),
          bytes: helperContent.byteLength,
        },
      ],
    }))

    const result = await fixture.cleanup.run({ reason: "completed", finalReport: fixture.finalReport })

    expect(result.status).toBe("complete")
    expect(result.resources.probes.map((probe) => probe.status)).toEqual(["already-clean", "success"])
    const cleanedSource = await readFile(fixture.sourceFile, "utf8")
    expect(cleanedSource).not.toContain("DEBUG-")
    expect(cleanedSource).not.toContain(specifier)
    await expect(readFile(helper, "utf8")).rejects.toThrow()
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

  it("allows cleanup to be retried after an execution rejects", async () => {
    const fixture = await createCleanupFixture({})

    await expect(fixture.cleanup.run({ reason: "invalid", finalReport: {} as never })).rejects.toThrow()

    const result = await fixture.cleanup.run({ reason: "completed", finalReport: fixture.finalReport })
    expect(result.status).toBe("complete")
    expect(fixture.removeSecret).toHaveBeenCalledOnce()
    expect(await fixture.sessionExists()).toBe(false)
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
