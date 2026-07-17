import path from "node:path"
import { type ParserPlugin, parse } from "@babel/parser"
import { DebugModeError } from "../core/errors.js"

type AstNode = {
  type: string
  start?: number | null
  end?: number | null
  [key: string]: unknown
}

type SentinelLocation = Readonly<{
  statement: AstNode
  container: AstNode
  statementIndex: number
  path: AstNode[]
}>

type StatementScope = Readonly<{
  container: AstNode
  containerPathIndex: number
  statements: AstNode[]
  statementIndex: number
}>

const STATEMENT_LIST_CONTAINERS = new Set(["Program", "BlockStatement", "SwitchCase", "StaticBlock", "TSModuleBlock"])

const TRAVERSAL_SKIP_KEYS = new Set(["comments", "errors", "extra", "loc", "tokens"])

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
}

function parserPlugins(sourceFile: string): ParserPlugin[] {
  const extension = path.extname(sourceFile).toLowerCase()
  const plugins: ParserPlugin[] = [
    "decorators-legacy",
    "decoratorAutoAccessors",
    "explicitResourceManagement",
    "importAttributes",
  ]
  if (extension === ".ts" || extension === ".tsx") plugins.push("typescript")
  if (extension === ".jsx" || extension === ".tsx") plugins.push("jsx")
  return plugins
}

function parseSource(source: string, sourceFile: string): AstNode {
  try {
    return parse(source, {
      sourceFilename: sourceFile,
      sourceType: "unambiguous",
      plugins: parserPlugins(sourceFile),
      allowAwaitOutsideFunction: true,
      allowNewTargetOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode
  } catch (error) {
    throw new DebugModeError(
      "MARKER_MISMATCH",
      "Probe marker location could not be verified as a complete executable statement boundary in JavaScript or TypeScript",
      false,
      {
        action:
          "Choose the first non-empty executable line after the complete containing statement; do not select a continuation line, expression body, call argument, or unbraced control-flow body",
        details: { parserMessage: error instanceof Error ? error.message : String(error) },
      },
    )
  }
}

function walkAst(node: AstNode, ancestors: AstNode[], visit: (node: AstNode, ancestors: AstNode[]) => void): void {
  visit(node, ancestors)
  const nextAncestors = [...ancestors, node]
  for (const [key, value] of Object.entries(node)) {
    if (TRAVERSAL_SKIP_KEYS.has(key)) continue
    if (Array.isArray(value)) {
      for (const candidate of value) {
        if (isAstNode(candidate)) walkAst(candidate, nextAncestors, visit)
      }
    } else if (isAstNode(value)) {
      walkAst(value, nextAncestors, visit)
    }
  }
}

function statementList(container: AstNode): AstNode[] | undefined {
  const value = container.type === "SwitchCase" ? container.consequent : container.body
  if (!Array.isArray(value) || !value.every(isAstNode)) return undefined
  return value
}

function locateSentinel(ast: AstNode, token: string): SentinelLocation {
  const matches: AstNode[][] = []
  walkAst(ast, [], (node, ancestors) => {
    if (node.type === "StringLiteral" && node.value === token) matches.push([...ancestors, node])
  })
  const pathToLiteral = matches[0]
  if (matches.length !== 1 || pathToLiteral === undefined || pathToLiteral.length < 4) {
    throw new DebugModeError(
      "MARKER_MISMATCH",
      "Probe marker must be inserted at a complete executable statement boundary",
      false,
      {
        action:
          "Choose the first non-empty executable line after the complete containing statement; do not select a continuation line, expression body, call argument, or unbraced control-flow body",
      },
    )
  }

  const literal = pathToLiteral.at(-1)
  const unary = pathToLiteral.at(-2)
  const statement = pathToLiteral.at(-3)
  const container = pathToLiteral.at(-4)
  if (
    literal === undefined ||
    unary === undefined ||
    statement === undefined ||
    container === undefined ||
    unary.type !== "UnaryExpression" ||
    unary.operator !== "void" ||
    unary.argument !== literal ||
    statement.type !== "ExpressionStatement" ||
    statement.expression !== unary ||
    !STATEMENT_LIST_CONTAINERS.has(container.type)
  ) {
    throw new DebugModeError(
      "MARKER_MISMATCH",
      "Probe marker must be inserted at a complete executable statement-list boundary",
      false,
      {
        action:
          "Choose the first non-empty executable line inside a module or braced block after the complete containing statement; callbacks with braced bodies are supported",
      },
    )
  }
  const statements = statementList(container)
  const statementIndex = statements?.indexOf(statement) ?? -1
  if (statementIndex < 0) {
    throw new DebugModeError("MARKER_MISMATCH", "Probe marker statement ownership could not be verified")
  }
  return { statement, container, statementIndex, path: pathToLiteral }
}

function isStringExpressionStatement(node: AstNode | undefined): boolean {
  if (node?.type !== "ExpressionStatement" || !isAstNode(node.expression)) return false
  const extra = node.expression.extra
  const parenthesized =
    typeof extra === "object" && extra !== null && (extra as { parenthesized?: unknown }).parenthesized === true
  return node.expression.type === "StringLiteral" && !parenthesized
}

function assertDirectiveProloguePreserved(location: SentinelLocation): void {
  const statements = statementList(location.container)
  if (statements === undefined) return
  // Babel stores directives separately. Once the sentinel is inserted before a
  // directive, the displaced directive becomes the first ordinary string
  // expression after the sentinel and would silently lose directive semantics.
  if (location.statementIndex === 0 && isStringExpressionStatement(statements[1])) {
    throw new DebugModeError(
      "MARKER_MISMATCH",
      "Probe marker cannot be inserted before a directive prologue statement",
      false,
      { action: "Choose the first executable statement after the complete directive prologue" },
    )
  }
}

function collectPatternBindings(pattern: AstNode | undefined, bindings: Set<string>): void {
  if (pattern === undefined) return
  if (pattern.type === "Identifier") {
    if (typeof pattern.name === "string") bindings.add(pattern.name)
    return
  }
  if (pattern.type === "RestElement") {
    collectPatternBindings(isAstNode(pattern.argument) ? pattern.argument : undefined, bindings)
    return
  }
  if (pattern.type === "AssignmentPattern") {
    collectPatternBindings(isAstNode(pattern.left) ? pattern.left : undefined, bindings)
    return
  }
  if (pattern.type === "ArrayPattern") {
    if (Array.isArray(pattern.elements)) {
      for (const element of pattern.elements) collectPatternBindings(isAstNode(element) ? element : undefined, bindings)
    }
    return
  }
  if (pattern.type === "ObjectPattern" && Array.isArray(pattern.properties)) {
    for (const property of pattern.properties) {
      if (!isAstNode(property)) continue
      if (property.type === "RestElement") {
        collectPatternBindings(isAstNode(property.argument) ? property.argument : undefined, bindings)
      } else if (property.type === "ObjectProperty") {
        collectPatternBindings(isAstNode(property.value) ? property.value : undefined, bindings)
      }
    }
  }
}

function collectDeclarationBindings(statement: AstNode | undefined, bindings: Set<string>, lexicalOnly: boolean): void {
  if (statement === undefined) return
  if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
    collectDeclarationBindings(
      isAstNode(statement.declaration) ? statement.declaration : undefined,
      bindings,
      lexicalOnly,
    )
    return
  }
  if (statement.type === "VariableDeclaration" && (!lexicalOnly || statement.kind !== "var")) {
    if (!Array.isArray(statement.declarations)) return
    for (const declaration of statement.declarations) {
      if (isAstNode(declaration))
        collectPatternBindings(isAstNode(declaration.id) ? declaration.id : undefined, bindings)
    }
    return
  }
  if (statement.type === "ClassDeclaration" && isAstNode(statement.id) && typeof statement.id.name === "string") {
    bindings.add(statement.id.name)
    return
  }
  if (!lexicalOnly && statement.type === "FunctionDeclaration" && isAstNode(statement.id)) {
    if (typeof statement.id.name === "string") bindings.add(statement.id.name)
    return
  }
  if (!lexicalOnly && statement.type === "ImportDeclaration" && Array.isArray(statement.specifiers)) {
    for (const specifier of statement.specifiers) {
      if (isAstNode(specifier) && isAstNode(specifier.local) && typeof specifier.local.name === "string") {
        bindings.add(specifier.local.name)
      }
    }
  }
}

function captureRoot(capturePath: string): string | undefined {
  return /^[A-Za-z_$][\w$]*/u.exec(capturePath)?.[0]
}

function statementScopes(location: SentinelLocation): StatementScope[] {
  const scopes: StatementScope[] = []
  for (let containerPathIndex = location.path.length - 1; containerPathIndex >= 0; containerPathIndex -= 1) {
    const container = location.path[containerPathIndex]
    if (container === undefined || !STATEMENT_LIST_CONTAINERS.has(container.type)) continue
    const statements = statementList(container)
    if (statements === undefined) continue
    let statementIndex = -1
    for (let pathIndex = containerPathIndex + 1; pathIndex < location.path.length; pathIndex += 1) {
      const descendant = location.path[pathIndex]
      if (descendant === undefined) continue
      statementIndex = statements.indexOf(descendant)
      if (statementIndex >= 0) break
    }
    if (statementIndex >= 0) scopes.push({ container, containerPathIndex, statements, statementIndex })
  }
  return scopes
}

function collectScopeBarrierBindings(nodes: AstNode[], bindings: Set<string>): void {
  for (const node of nodes) {
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"].includes(
        node.type,
      )
    ) {
      if (Array.isArray(node.params)) {
        for (const parameter of node.params) {
          collectPatternBindings(isAstNode(parameter) ? parameter : undefined, bindings)
        }
      }
      if (isAstNode(node.id) && typeof node.id.name === "string") bindings.add(node.id.name)
    } else if (node.type === "CatchClause") {
      collectPatternBindings(isAstNode(node.param) ? node.param : undefined, bindings)
    } else if (node.type === "ClassExpression" && isAstNode(node.id) && typeof node.id.name === "string") {
      bindings.add(node.id.name)
    }
  }
}

function assertCapturesInitialized(
  location: SentinelLocation,
  captures: ReadonlyArray<Readonly<{ path: string }>>,
): void {
  if (captures.length === 0) return
  const unresolvedRoots = new Set(
    captures.map((capture) => captureRoot(capture.path)).filter((root) => root !== undefined),
  )
  const unsafeRoots = new Set<string>()
  const scopes = statementScopes(location)
  for (const [scopeIndex, scope] of scopes.entries()) {
    const lexicalAtOrAfter = new Set<string>()
    for (const statement of scope.statements.slice(scope.statementIndex)) {
      collectDeclarationBindings(statement, lexicalAtOrAfter, true)
    }
    for (const root of unresolvedRoots) {
      if (lexicalAtOrAfter.has(root)) unsafeRoots.add(root)
    }

    const scopeBindings = new Set<string>()
    for (const statement of scope.statements) collectDeclarationBindings(statement, scopeBindings, false)
    for (const root of scopeBindings) unresolvedRoots.delete(root)

    const nextOuterScope = scopes[scopeIndex + 1]
    if (nextOuterScope !== undefined) {
      const barrierBindings = new Set<string>()
      collectScopeBarrierBindings(
        location.path.slice(nextOuterScope.containerPathIndex + 1, scope.containerPathIndex),
        barrierBindings,
      )
      for (const root of barrierBindings) unresolvedRoots.delete(root)
    }
  }
  if (unsafeRoots.size === 0) return
  const orderedUnsafeRoots = [...unsafeRoots]
  const initializationMessage =
    orderedUnsafeRoots.length === 1
      ? `before the selected declaration initializes it`
      : `before the selected declarations initialize them`
  throw new DebugModeError(
    "UNSAFE_CAPTURE",
    `Probe cannot capture ${orderedUnsafeRoots.join(", ")} ${initializationMessage}; a lexical binding exists at or after the anchor`,
    false,
    {
      action: `Choose the first complete statement boundary after ${orderedUnsafeRoots.join(", ")} ${orderedUnsafeRoots.length === 1 ? "has" : "have"} been initialized`,
      details: { unsafeCaptureRoots: orderedUnsafeRoots.join(",") },
    },
  )
}

function uniqueSentinelToken(source: string): string {
  let suffix = 0
  while (true) {
    const token = `__opencode_debug_statement_boundary_${suffix}__`
    if (!source.includes(token)) return token
    suffix += 1
  }
}

/**
 * Proves that an instrumentation anchor is a real statement-list boundary.
 * A parser sentinel is intentionally used instead of delimiter heuristics so
 * syntactically valid-but-semantic rewrites (for example an extra call
 * argument or an unbraced `if` body) are rejected before instrumentation.
 */
export function assertProbeStatementBoundary(
  input: Readonly<{
    source: string
    offset: number
    sourceFile: string
    captures: ReadonlyArray<Readonly<{ path: string }>>
  }>,
): void {
  if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > input.source.length) {
    throw new DebugModeError("MARKER_MISMATCH", "Probe marker source offset is invalid")
  }
  const token = uniqueSentinelToken(input.source)
  const sentinel = `void ${JSON.stringify(token)};\n`
  const ast = parseSource(
    input.source.slice(0, input.offset) + sentinel + input.source.slice(input.offset),
    input.sourceFile,
  )
  const location = locateSentinel(ast, token)
  assertDirectiveProloguePreserved(location)
  assertCapturesInitialized(location, input.captures)
}
