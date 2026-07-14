import { StringDecoder } from "node:string_decoder"
import { PROCESS_EVENT_PREFIX } from "../core/constants.js"

export type ProcessStream = "stdout" | "stderr"
export type DecodedProcessRecord =
  | { kind: "output"; stream: ProcessStream; text: string; rejectedProbe?: boolean }
  | { kind: "probe-candidate"; stream: ProcessStream; value: unknown }
  | { kind: "truncated"; stream: ProcessStream; maximumBytes: number }

type StreamState = { decoder: StringDecoder; pending: string; discarding: boolean }

export class ProcessLineDecoder {
  private readonly streams: Record<ProcessStream, StreamState> = {
    stdout: { decoder: new StringDecoder("utf8"), pending: "", discarding: false },
    stderr: { decoder: new StringDecoder("utf8"), pending: "", discarding: false },
  }

  constructor(private readonly options: { maxLineBytes: number }) {}

  push(stream: ProcessStream, chunk: Buffer): DecodedProcessRecord[] {
    return this.consume(stream, this.streams[stream].decoder.write(chunk))
  }

  flush(stream: ProcessStream): DecodedProcessRecord[] {
    const state = this.streams[stream]
    const records = this.consume(stream, state.decoder.end())
    if (!state.discarding && state.pending.length > 0) {
      records.push(this.decodeLine(stream, state.pending.replace(/\r$/u, "")))
    }
    state.pending = ""
    state.discarding = false
    return records
  }

  private consume(stream: ProcessStream, text: string): DecodedProcessRecord[] {
    const state = this.streams[stream]
    const records: DecodedProcessRecord[] = []
    let remainder = text
    if (state.discarding) {
      const newline = remainder.indexOf("\n")
      if (newline < 0) return records
      state.discarding = false
      remainder = remainder.slice(newline + 1)
    }
    state.pending += remainder

    while (true) {
      const newline = state.pending.indexOf("\n")
      if (newline < 0) break
      const line = state.pending.slice(0, newline).replace(/\r$/u, "")
      state.pending = state.pending.slice(newline + 1)
      if (Buffer.byteLength(line) > this.options.maxLineBytes) {
        records.push({ kind: "truncated", stream, maximumBytes: this.options.maxLineBytes })
      } else {
        records.push(this.decodeLine(stream, line))
      }
    }

    if (Buffer.byteLength(state.pending) > this.options.maxLineBytes) {
      state.pending = ""
      state.discarding = true
      records.push({ kind: "truncated", stream, maximumBytes: this.options.maxLineBytes })
    }
    return records
  }

  private decodeLine(stream: ProcessStream, text: string): DecodedProcessRecord {
    if (!text.startsWith(PROCESS_EVENT_PREFIX)) return { kind: "output", stream, text }
    try {
      return { kind: "probe-candidate", stream, value: JSON.parse(text.slice(PROCESS_EVENT_PREFIX.length)) }
    } catch {
      return { kind: "output", stream, text, rejectedProbe: true }
    }
  }
}
