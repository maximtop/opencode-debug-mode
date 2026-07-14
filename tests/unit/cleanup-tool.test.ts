import { describe, expect, it, vi } from "vitest"
import { createCleanupTool } from "../../src/tools/cleanup-tool.js"
import { toolContextFixture } from "../helpers/factories.js"

const report = {
  outcome: "completed" as const,
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
    const tool = createCleanupTool(
      { requireOwned: vi.fn().mockResolvedValue(session) } as never,
      () => ({ run }) as never,
    )
    const cleanCheck = { executable: process.execPath, args: ["--version"], cwd: "/project", timeoutMs: 1_000 }
    const result = JSON.parse(
      (await tool.execute({ reason: "completed", finalReport: report, cleanCheck }, toolContextFixture())) as string,
    )
    expect(run).toHaveBeenCalledWith({ reason: "completed", finalReport: report, cleanCheck })
    expect(result.data.resources.probes).toEqual([
      { status: "success", location: "src/example.ts" },
      { status: "failed", reason: "fixture" },
    ])
    expect(result.data.resources.permissions[0].location).toBe(".")
    expect(result.data.resources.files[0].location).toBeUndefined()
    expect(result.data.remainingArtifacts).toEqual(["src/example.ts"])
  })
})
