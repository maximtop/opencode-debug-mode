import { describe, expect, it } from "vitest"
import { assertProbeStatementBoundary } from "../../src/probes/statement-boundary.js"

function lineOffset(source: string, text: string): number {
  const offset = source.indexOf(text)
  if (offset < 0) throw new Error(`Missing fixture line: ${text}`)
  return offset
}

function assertBoundary(input: { source: string; line: string; sourceFile?: string; captures?: string[] }): void {
  assertProbeStatementBoundary({
    source: input.source,
    offset: lineOffset(input.source, input.line),
    sourceFile: input.sourceFile ?? "fixture.ts",
    captures: (input.captures ?? []).map((path) => ({ path })),
  })
}

function boundaryError(input: Parameters<typeof assertBoundary>[0]): unknown {
  try {
    assertBoundary(input)
  } catch (error) {
    return error
  }
  throw new Error("Expected statement-boundary validation to fail")
}

describe("probe statement boundaries", () => {
  it("rejects the exact multiline call-closing anchor from the real AG-55256 run", () => {
    const source = [
      "async function download(customFilter: { filterDownloadPageUrl: string }) {",
      "  const downloadData = await FiltersDownloader.downloadWithRaw(",
      "    customFilter.filterDownloadPageUrl,",
      "    { force: true },",
      "  );",
      "  return downloadData",
      "}",
      "",
    ].join("\n")

    expect(
      boundaryError({ source, line: "  );", captures: ["downloadData.filter.length", "downloadData.headers"] }),
    ).toMatchObject({
      code: "MARKER_MISMATCH",
      message: expect.stringContaining("complete executable statement boundary"),
    })
  })

  it("rejects multiline initializers, arrow expressions, and unbraced control-flow bodies", () => {
    const multiline = ["async function load() {", "  const result =", "    await download()", "}", ""].join("\n")
    expect(boundaryError({ source: multiline, line: "    await", captures: ["result"] })).toMatchObject({
      code: "MARKER_MISMATCH",
    })

    const arrow = ["const compute = () =>", "  current + 1", ""].join("\n")
    expect(boundaryError({ source: arrow, line: "  current", captures: ["current"] })).toMatchObject({
      code: "MARKER_MISMATCH",
      message: expect.stringContaining("statement-list boundary"),
    })

    for (const source of [
      ["if (ready)", "  run()", ""].join("\n"),
      ["while (ready)", "  run()", ""].join("\n"),
      ["for (const item of items)", "  consume(item)", ""].join("\n"),
    ]) {
      expect(boundaryError({ source, line: "  ", captures: [] })).toMatchObject({
        code: "MARKER_MISMATCH",
        message: expect.stringContaining("statement-list boundary"),
      })
    }
  })

  it("allows initialized captures at module, function, callback, switch-case, and TSX block boundaries", () => {
    const postInit = [
      "async function load() {",
      "  const downloadData = await download()",
      "  return downloadData",
      "}",
      "",
    ].join("\n")
    expect(() =>
      assertBoundary({ source: postInit, line: "  return", captures: ["downloadData.filter"] }),
    ).not.toThrow()

    const callback = [
      "await withDownload(async () => {",
      "  const downloadData = await download()",
      "  return downloadData",
      "})",
      "",
    ].join("\n")
    expect(() => assertBoundary({ source: callback, line: "  return", captures: ["downloadData"] })).not.toThrow()

    const switchCase = [
      "switch (kind) {",
      "  case 'download': {",
      "    const downloadData = await download()",
      "    consume(downloadData)",
      "    break",
      "  }",
      "}",
      "",
    ].join("\n")
    expect(() => assertBoundary({ source: switchCase, line: "    consume", captures: ["downloadData"] })).not.toThrow()

    const tsx = ["function View() {", "  const content: JSX.Element = <section />", "  return content", "}", ""].join(
      "\n",
    )
    expect(() =>
      assertBoundary({ source: tsx, line: "  return", sourceFile: "fixture.tsx", captures: ["content"] }),
    ).not.toThrow()
  })

  it("rejects later lexical capture roots including destructuring and classes", () => {
    const fixtures = [
      {
        source: ["observe(downloadData)", "const downloadData = await download()", ""].join("\n"),
        capture: "downloadData.filter",
      },
      {
        source: ["observe(downloadData)", "let downloadData = await download()", ""].join("\n"),
        capture: "downloadData",
      },
      {
        source: ["observe(downloadData)", "const { downloadData } = await download()", ""].join("\n"),
        capture: "downloadData.headers",
      },
      {
        source: ["observe(downloadData)", "const [, downloadData, ...rest] = await download()", ""].join("\n"),
        capture: "downloadData",
      },
      {
        source: ["observe(Service)", "class Service {}", ""].join("\n"),
        capture: "Service.name",
      },
    ]

    for (const fixture of fixtures) {
      expect(boundaryError({ source: fixture.source, line: "observe", captures: [fixture.capture] })).toMatchObject({
        code: "UNSAFE_CAPTURE",
        message: expect.stringContaining("before the selected declaration initializes"),
      })
    }
  })

  it("checks later bindings in enclosing scopes without crossing a parameter shadow", () => {
    const enclosingTdz = [
      "function schedule() {",
      "  const callback = () => {",
      "    observe(downloadData)",
      "  }",
      "  const downloadData = download()",
      "  callback()",
      "}",
      "",
    ].join("\n")
    expect(boundaryError({ source: enclosingTdz, line: "    observe", captures: ["downloadData"] })).toMatchObject({
      code: "UNSAFE_CAPTURE",
      details: { unsafeCaptureRoots: "downloadData" },
    })

    const parameterShadow = [
      "const callback = (downloadData: Download) => {",
      "  observe(downloadData)",
      "}",
      "const downloadData = download()",
      "",
    ].join("\n")
    expect(() =>
      assertBoundary({ source: parameterShadow, line: "  observe", captures: ["downloadData.filter"] }),
    ).not.toThrow()
  })

  it("preserves directive prologues", () => {
    const source = ["function strictMode() {", '  "use strict"', "  return this", "}", ""].join("\n")
    expect(boundaryError({ source, line: '  "use strict"', captures: [] })).toMatchObject({
      code: "MARKER_MISMATCH",
      message: expect.stringContaining("directive prologue"),
    })
    expect(() => assertBoundary({ source, line: "  return", captures: [] })).not.toThrow()
  })
})
