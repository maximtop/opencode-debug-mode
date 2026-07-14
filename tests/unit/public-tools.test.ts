import { describe, expect, it } from "vitest"
import { createDebugTools } from "../../src/tools/index.js"
import { publicToolsFixture, toolContextFixture } from "../helpers/factories.js"

const expectedNames = [
  "debug_session_start",
  "debug_session_status",
  "debug_state_read",
  "debug_state_checkpoint",
  "debug_run_start",
  "debug_process_capture",
  "debug_collector_start",
  "debug_probe_prepare",
  "debug_probe_register",
  "debug_evidence_read",
  "debug_cleanup",
]

describe("public tools", () => {
  it("registers the stable v1 names and scopes by ToolContext.sessionID", async () => {
    const fixture = publicToolsFixture()
    const tools = createDebugTools(fixture.dependencies)
    expect(Object.keys(tools).sort()).toEqual([...expectedNames].sort())
    const result = JSON.parse(
      (await tools.debug_session_status.execute({}, toolContextFixture({ sessionID: "other" }))) as string,
    )
    expect(result).toMatchObject({ ok: false, error: { code: "NO_ACTIVE_SESSION" } })
    expect(fixture.registry.requireOwned).toHaveBeenCalledWith("other")
  })
})
