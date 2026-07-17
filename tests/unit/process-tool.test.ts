import { describe, expect, it, vi } from "vitest"
import { DebugModeError } from "../../src/core/errors.js"
import { validateRuntimeCaptureEnvironment } from "../../src/process/command-policy.js"
import { createProcessCaptureTool } from "../../src/tools/run-tools.js"
import { processArgsFixture, toolContextFixture, toolDependenciesFixture } from "../helpers/factories.js"

describe("debug_process_capture", () => {
  it("documents the outcome predicate contract for instrumentation checks", () => {
    const processTool = createProcessCaptureTool(toolDependenciesFixture())
    expect(processTool.description).toContain("omit outcomePredicate for instrumentation-check")
  })

  it("asks before credential/device/external-state commands", async () => {
    const ask = vi.fn().mockResolvedValue(undefined)
    const tool = createProcessCaptureTool(toolDependenciesFixture())
    await tool.execute(processArgsFixture({ approvalClass: "credentials" }), toolContextFixture({ ask }))
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: "debug_process_external" }))
  })

  it("validates instrumentation, gates reproduction, and asks for an external directory", async () => {
    const dependencies = toolDependenciesFixture()
    const probes = dependencies.probesFor({} as never)
    dependencies.probesFor = () => probes
    const tool = createProcessCaptureTool(dependencies)
    const ask = vi.fn().mockResolvedValue(undefined)
    const checked = JSON.parse(
      (await tool.execute(
        processArgsFixture({ purpose: "instrumentation-check", probeIds: ["probe_A"], outcomePredicate: undefined }),
        toolContextFixture({ ask }),
      )) as string,
    )
    expect(checked.ok).toBe(true)
    expect(checked.data.validatedProbeIds).toEqual(["probe_A"])
    expect(probes.validate).toHaveBeenCalledWith(["probe_A"])

    await tool.execute(processArgsFixture({ purpose: "reproduction", cwd: "/outside" }), toolContextFixture({ ask }))
    expect(probes.requireValidatedForRun).toHaveBeenCalledWith("run_fixture")
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: "external_directory" }))
  })

  it("returns safe expected and unexpected capture failures", async () => {
    const expected = toolDependenciesFixture()
    expected.processFor = () => ({
      capture: vi.fn().mockRejectedValue(new DebugModeError("PROCESS_START_FAILED", "safe", true)),
    })
    expect(
      JSON.parse(
        (await createProcessCaptureTool(expected).execute(processArgsFixture(), toolContextFixture())) as string,
      ),
    ).toMatchObject({ error: { code: "PROCESS_START_FAILED", message: "safe", retryable: true } })

    const unexpected = toolDependenciesFixture()
    unexpected.processFor = () => ({ capture: vi.fn().mockRejectedValue(new Error("secret")) })
    expect(
      JSON.parse(
        (await createProcessCaptureTool(unexpected).execute(processArgsFixture(), toolContextFixture())) as string,
      ),
    ).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "Process capture failed" } })
  })

  it("returns an actionable error when OpenCode omits the required executable", async () => {
    const dependencies = toolDependenciesFixture()
    const capture = dependencies.processFor({} as never).capture
    dependencies.processFor = () => ({ capture })
    const args: Record<string, unknown> = { ...processArgsFixture() }
    delete args.executable

    const result = JSON.parse(
      (await createProcessCaptureTool(dependencies).execute(args as never, toolContextFixture())) as string,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PROCESS_START_FAILED",
        message: "Process capture requires the executable field",
        retryable: true,
        action: expect.stringContaining('executable: "node"'),
      },
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it.each([
    { NODE_OPTIONS: "--loader=/tmp/writer.mjs" },
    { PATH: "/tmp/bin" },
    { TEST_CONFIG: "/tmp/config.ts" },
  ])("rejects unsafe environment override %j before process capture", async (env) => {
    const dependencies = toolDependenciesFixture()
    const capture = dependencies.processFor({} as never).capture
    dependencies.processFor = () => ({ capture })
    dependencies.capturePolicy = vi.fn(async (input) => validateRuntimeCaptureEnvironment(input.env))
    const result = JSON.parse(
      (await createProcessCaptureTool(dependencies).execute(
        processArgsFixture({ env }),
        toolContextFixture(),
      )) as string,
    )
    expect(result).toMatchObject({ error: { code: "INVALID_PHASE" } })
    expect(capture).not.toHaveBeenCalled()
  })

  it("passes the exact environment through policy validation and capture", async () => {
    const dependencies = toolDependenciesFixture()
    const capture = vi.fn().mockResolvedValue({
      processId: "process_fixture",
      runId: "run_fixture",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      stdoutEvents: 0,
      stderrEvents: 0,
      probeEvents: 0,
      probeIds: [],
      matchingProbeEvents: 0,
      issueReproduced: false,
      outcomePredicate: { kind: "exit-code", operator: "not-equals", value: 0 },
      resultEvidenceId: "event_process_fixture",
    })
    dependencies.processFor = () => ({ capture })
    const capturePolicy = vi.fn().mockResolvedValue(undefined)
    dependencies.capturePolicy = capturePolicy
    const env = { CI: "true", NODE_ENV: "test" }

    await createProcessCaptureTool(dependencies).execute(processArgsFixture({ env }), toolContextFixture())

    expect(capturePolicy).toHaveBeenCalledWith(expect.objectContaining({ env }))
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ env }))
  })
})
