import { describe, expect, it } from "vitest"
import { parseChildMessage, parseParentMessage } from "../../src/process/protocol.js"

describe("process supervisor protocol", () => {
  it("rejects unknown and oversized messages", () => {
    expect(() => parseParentMessage({ type: "unknown" })).toThrow()
    expect(() => parseParentMessage({ type: "terminate", reason: "x".repeat(70_000) })).toThrow()
    expect(parseParentMessage({ type: "terminate", reason: "abort" })).toEqual({ type: "terminate", reason: "abort" })
  })

  it("rejects non-serializable messages before schema validation", () => {
    const circular: { self?: unknown } = {}
    circular.self = circular

    expect(() => parseParentMessage(circular)).toThrow("IPC message is not serializable")
  })

  it("validates bounded start messages including the environment limit", () => {
    const start = {
      type: "start" as const,
      executable: process.execPath,
      args: ["--version"],
      cwd: "/project",
      env: { CI: "true" },
      timeoutMs: 1_000,
      ownerNonce: "a".repeat(32),
    }
    expect(parseParentMessage(start)).toEqual(start)

    const excessiveEnvironment = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`VARIABLE_${index}`, String(index)]),
    )
    expect(() => parseParentMessage({ ...start, env: excessiveEnvironment })).toThrow()
  })

  it("accepts every child message variant and rejects invalid child payloads", () => {
    expect(parseChildMessage({ type: "ready" })).toEqual({ type: "ready" })
    expect(parseChildMessage({ type: "started", targetPid: 42 })).toEqual({ type: "started", targetPid: 42 })
    expect(
      parseChildMessage({
        type: "result",
        targetPid: 42,
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        termination: {
          graceful: true,
          forced: false,
          remaining: false,
          durationMs: 12,
          errors: [],
        },
      }),
    ).toMatchObject({ type: "result", targetPid: 42, timedOut: true })
    expect(parseChildMessage({ type: "failure", code: "SPAWN_FAILED", message: "failed" })).toEqual({
      type: "failure",
      code: "SPAWN_FAILED",
      message: "failed",
    })
    expect(() => parseChildMessage({ type: "started", targetPid: 0 })).toThrow()
  })
})
