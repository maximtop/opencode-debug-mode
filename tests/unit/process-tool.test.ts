import { describe, expect, it, vi } from "vitest"
import { DebugModeError } from "../../src/core/errors.js"
import { createProcessCaptureTool } from "../../src/tools/run-tools.js"
import { processArgsFixture, toolContextFixture, toolDependenciesFixture } from "../helpers/factories.js"

describe("debug_process_capture", () => {
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
        processArgsFixture({ purpose: "instrumentation-check", probeIds: ["probe_A"] }),
        toolContextFixture({ ask }),
      )) as string,
    )
    expect(checked.ok).toBe(true)
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
})
