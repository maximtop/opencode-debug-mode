import { describe, expect, it, vi } from "vitest"
import { createCleanupTool } from "../../src/tools/cleanup-tool.js"
import { toolContextFixture } from "../helpers/factories.js"

const report = {
  outcome: "unresolved" as const,
  rootCause: "fixture",
  decidingEvidence: [],
  hypotheses: [],
  fix: "fixture",
  changedFiles: [],
  verification: ["fixture"],
}

describe("debug_cleanup", () => {
  it("passes a clean check and exposes only project-relative artifact locations", async () => {
    const session = { projectRoot: "/project" }
    const run = vi.fn().mockResolvedValue({
      status: "partial",
      reason: "completed",
      resources: {
        collector: { status: "already-clean" },
        processes: [],
        probes: [
          { status: "success", location: "/project/src/example.ts" },
          { status: "failed", reason: "fixture" },
        ],
        permissions: [{ status: "success", location: "/project" }],
        files: [{ status: "failed", reason: "outside", location: "/outside/secret" }],
        secret: { status: "success" },
        sessionDirectory: { status: "success" },
      },
      remainingArtifacts: ["/project/src/example.ts", "/outside/secret"],
      durationMs: 1,
    })
    const registry = {
      requireOwned: vi.fn().mockResolvedValue(session),
      forgetTrusted: vi.fn(),
    }
    const onCleaned = vi.fn()
    const tool = createCleanupTool(
      registry as never,
      () => ({ run }) as never,
      () => ({}) as never,
      onCleaned,
    )
    const cleanCheck = { executable: "git", args: ["status", "--porcelain"], cwd: "/project", timeoutMs: 1_000 }
    const result = JSON.parse(
      (await tool.execute(
        { reason: "unresolved", finalReport: JSON.stringify(report), cleanCheck } as never,
        toolContextFixture(),
      )) as string,
    )
    expect(run).toHaveBeenCalledWith({ reason: "unresolved", finalReport: report, cleanCheck })
    expect(result.data.resources.probes).toEqual([
      { status: "success", location: "src/example.ts" },
      { status: "failed", reason: "fixture" },
    ])
    expect(result.data.resources.permissions[0].location).toBe(".")
    expect(result.data.resources.files[0].location).toBeUndefined()
    expect(result.data.remainingArtifacts).toEqual(["src/example.ts"])
    expect(registry.forgetTrusted).toHaveBeenCalledWith(toolContextFixture().sessionID)
    expect(onCleaned).toHaveBeenCalledWith(session)
  })

  it("derives an omitted report from durable state", async () => {
    const session = {
      projectRoot: "/project",
      investigationStore: {
        read: vi.fn().mockResolvedValue({
          hypotheses: [
            { id: "H1", status: "confirmed", statement: "confirmed cause" },
            { id: "H2", status: "eliminated", statement: "other cause" },
          ],
          decidingEvidenceIds: ["event_deciding"],
          decisions: [{ summary: "targeted fix" }],
          runs: [{ label: "pre-fix", observation: "issue reproduced" }],
        }),
      },
      manifestStore: {
        read: vi.fn().mockResolvedValue({
          behavioralMutations: [{ paths: ["src/example.ts"] }],
        }),
      },
    }
    const run = vi.fn().mockResolvedValue({
      status: "complete",
      reason: "cancelled",
      resources: {
        collector: { status: "already-clean" },
        processes: [],
        probes: [],
        permissions: [],
        files: [],
        secret: { status: "success" },
        sessionDirectory: { status: "success" },
      },
      remainingArtifacts: [],
      durationMs: 1,
    })
    const tool = createCleanupTool(
      {
        requireOwned: vi.fn().mockResolvedValue(session),
        forgetTrusted: vi.fn(),
      } as never,
      () => ({ run }) as never,
      () => ({}) as never,
    )

    const result = JSON.parse((await tool.execute({ reason: "cancelled" } as never, toolContextFixture())) as string)

    expect(result.ok).toBe(true)
    expect(run).toHaveBeenCalledWith({
      reason: "cancelled",
      finalReport: {
        outcome: "abandoned",
        rootCause: "confirmed cause",
        decidingEvidence: ["event_deciding"],
        hypotheses: [
          { id: "H1", status: "confirmed", statement: "confirmed cause" },
          { id: "H2", status: "eliminated", statement: "other cause" },
        ],
        fix: "targeted fix",
        changedFiles: ["src/example.ts"],
        verification: ["pre-fix: issue reproduced"],
      },
    })
  })
})
