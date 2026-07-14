import { describe, expect, it } from "vitest"
import { PROCESS_EVENT_PREFIX } from "../../src/core/constants.js"
import { ProcessLineDecoder } from "../../src/process/line-decoder.js"

describe("process output decoder", () => {
  it("reassembles UTF-8 and recognizes only valid registered probe lines", () => {
    const decoder = new ProcessLineDecoder({ maxLineBytes: 8_192 })
    expect(decoder.push("stderr", Buffer.from("hel"))).toEqual([])
    expect(decoder.push("stderr", Buffer.from("lo\n"))).toEqual([{ kind: "output", stream: "stderr", text: "hello" }])
    const line = `${PROCESS_EVENT_PREFIX}{"schemaVersion":1,"probeId":"probe_A"}\n`
    expect(decoder.push("stderr", Buffer.from(line))[0]?.kind).toBe("probe-candidate")
  })

  it("handles CRLF, invalid probes, partial flushes, and oversized lines independently", () => {
    const decoder = new ProcessLineDecoder({ maxLineBytes: 5 })
    expect(decoder.push("stdout", Buffer.from("ok\r\n"))).toEqual([{ kind: "output", stream: "stdout", text: "ok" }])
    const invalidProbe = new ProcessLineDecoder({ maxLineBytes: 1_024 })
    expect(invalidProbe.push("stderr", Buffer.from(`${PROCESS_EVENT_PREFIX}{bad}\n`))).toEqual([
      expect.objectContaining({ kind: "output", stream: "stderr", rejectedProbe: true }),
    ])
    expect(decoder.push("stdout", Buffer.from("123456"))).toEqual([
      { kind: "truncated", stream: "stdout", maximumBytes: 5 },
    ])
    expect(decoder.push("stdout", Buffer.from("still discarded"))).toEqual([])
    expect(decoder.push("stdout", Buffer.from("\na\n123456\n"))).toEqual([
      { kind: "output", stream: "stdout", text: "a" },
      { kind: "truncated", stream: "stdout", maximumBytes: 5 },
    ])
    expect(decoder.push("stderr", Buffer.from("tail"))).toEqual([])
    expect(decoder.flush("stderr")).toEqual([{ kind: "output", stream: "stderr", text: "tail" }])
    expect(decoder.flush("stdout")).toEqual([])
  })
})
