# Feature Specification: OpenCode Debug Mode

**Created**: 2026-07-13
**Status**: Validated
**Model**: GPT-5 (Codex), high reasoning effort
**Input**: Create a standalone MIT-licensed OpenCode plugin named `opencode-debug-mode` that provides an explicit, hypothesis-driven runtime debugging agent and `/debug` command. Version 1 must support cross-platform CLI capture and an ephemeral authenticated HTTP collector, automatically clean all debug artifacts, and be suitable for later publication as an independent open-source npm package.

## Assumptions

- This is a new repository with no existing README or compatibility obligations; the original Cursor/VS Code Debug Mode agent and the audited community projects are product references, not an existing codebase to preserve.
- Version 1 targets OpenCode 1.17 or newer, Node.js 20 or newer, and current supported versions of macOS, Linux, and Windows.
- Debug Mode activation is explicit: users either select the `debug` agent or invoke `/debug`; generic errors do not activate it automatically.
- `/debug` is a routing shortcut to the same `debug` agent and does not contain a second copy of the workflow.
- Version 1 includes only two evidence backends: direct process stdout/stderr capture and an ephemeral loopback HTTP collector. Chrome DevTools, DAP, and `mcp-debugger` integration are outside version 1.
- JavaScript and TypeScript are the first-class instrumented languages in version 1. The CLI backend can capture any executable process, while Python and Go probe adapters are not advertised until their generated probes pass syntax, compile, and integration tests.
- HTTP debug events are untrusted input even though the collector is loopback-only. The collector therefore authenticates, validates, bounds, redacts, and isolates all input before persistence.
- The collector accepts at most 64 KiB per request, 8 KiB per scalar field after serialization, 25,000 events, and 25 MiB of evidence per session. A session expires after 30 minutes without activity unless the agent is actively running a command or waiting for a recorded reproduction response.
- Session bearer tokens contain at least 256 bits of cryptographically secure randomness and are never written into source manifests, reports, retained artifacts, or user-visible logs.
- `keepArtifacts` defaults to `false`. When explicitly enabled, the user must choose a destination; only sanitized evidence and the final report are copied there before the ephemeral working directory is removed.
- Each active investigation maintains a compact, durable `investigation-state.json` checkpoint outside the model context and inside the session's isolated temporary directory. It is ephemeral by default but survives conversation compaction and task resumption until the debug session is completed or abandoned.
- The investigation checkpoint is capped at 256 KiB and stores conclusions and references to evidence rather than duplicating raw logs, source files, terminal output, or conversation history.
- Existing MIT-licensed projects may contribute small selectively ported pieces only when attribution is preserved. Their collector, probe-generation, and cleanup implementations are not reused wholesale.
- No telemetry, remote storage, account system, hosted service, or automatic publishing is part of this feature.

## User Scenarios & Testing

### User Story 1 - Diagnose a CLI or server failure from runtime evidence (Priority: P1)

A developer installs the plugin, selects the `debug` agent or invokes `/debug`, and supplies a failing command or bug description. The agent forms ranked hypotheses, runs targeted checks and instrumentation, captures the process output, confirms or eliminates hypotheses, applies the smallest evidence-backed fix, verifies it, and removes all temporary debug state.

**Why this priority**: This is the smallest end-to-end Debug Mode journey that delivers the core value without requiring human reproduction or a browser runtime.

**Independent Test**: Install the package into an OpenCode test environment and debug a deterministic JavaScript/TypeScript CLI fixture whose failure requires observing a runtime branch value. Verify the root-cause report and clean working tree.

**Acceptance Scenarios**:

1. **Given** a project with a reproducible failing command, **When** the developer invokes `/debug` with the symptom, **Then** the debug agent records expected and actual behavior, produces ranked falsifiable hypotheses, captures a failing baseline, and does not edit behavioral code before hypotheses exist.
2. **Given** a hypothesis-specific probe and a runnable command, **When** the command executes, **Then** stdout, stderr, exit code, timing, timeout state, run label, and correlated probe events are available as structured evidence.
3. **Given** evidence that confirms a root cause, **When** the agent applies and verifies a minimal fix, **Then** the final report compares baseline and post-fix evidence and distinguishes confirmed, eliminated, and inconclusive hypotheses.
4. **Given** a completed CLI debug session with default settings, **When** the final report is produced, **Then** all child processes, probes, manifests, logs, temporary directories, and tokens are gone and unrelated user changes remain intact.

---

### User Story 2 - Diagnose a browser or extension bug reproduced by the developer (Priority: P2)

A developer uses Debug Mode for a web application, browser extension, service worker, or other runtime that OpenCode cannot launch directly. The agent starts a session-scoped HTTP collector, inserts minimal authenticated probes, gives only target reproduction instructions, receives structured evidence automatically, and continues the same evidence-to-fix workflow.

**Why this priority**: Human-reproduced browser and extension failures are the principal reason to provide a local collector, but the collector can be delivered after the CLI vertical slice.

**Independent Test**: Run a browser fixture and an extension fixture that POST authenticated pre-fix and post-fix events to the collector. Reproduce the defect manually and verify evidence correlation, fix validation, and cleanup without asking the user to copy logs or inspect collector internals.

**Acceptance Scenarios**:

1. **Given** an active debug session, **When** HTTP collection starts, **Then** the collector binds only to loopback on an available random port and exposes only authenticated ingestion, authenticated minimal health, and CORS preflight needed for ingestion.
2. **Given** a web application with session-owned probes, **When** the developer reproduces the symptom, **Then** events arrive automatically with run, hypothesis, probe, timestamp, message, bounded data, and source-location correlation.
3. **Given** a browser extension with content and background contexts, **When** probes are required in a content script, **Then** content events use the extension's messaging style and a bounded background relay rather than fetching loopback directly from the content script.
4. **Given** a completed browser debug workflow, **When** cleanup runs, **Then** temporary loopback permissions are removed only if this session added them, all session-owned marker blocks and tracking records are removed, and the cleaned target still builds.

---

### User Story 3 - Resume after context compaction or interruption (Priority: P2)

A long investigation may exceed the model context, continue in a later turn, or be interrupted by cancellation, timeout, or a plugin/process crash. The agent restores the compact investigation checkpoint before taking another action, avoids repeating conclusive checks, and either continues safely or cleans only the resources owned by that session.

**Why this priority**: Durable investigation memory and automatic cleanup are both part of the product's safety contract. A long-running Debug Mode is not useful if compaction makes it forget eliminated hypotheses or if interruption leaves runtime resources behind.

**Independent Test**: Force context compaction and task resumption at each lifecycle phase, then interrupt fixtures and restart OpenCode. Verify state restoration, absence of redundant checks, idempotent cleanup, and preservation of unrelated edits.

**Acceptance Scenarios**:

1. **Given** an active collector and child process, **When** the OpenCode session is cancelled, deleted, or the plugin is disposed, **Then** owned processes and listeners are stopped and ephemeral evidence is removed.
2. **Given** a crash prevented shutdown hooks from completing, **When** the plugin next starts, **Then** it identifies expired orphan manifests, verifies ownership, performs cleanup, and reports any partial failure without deleting unrelated files.
3. **Given** source code changed after probes were inserted, **When** cleanup runs, **Then** only marker blocks whose content and ownership match the manifest are removed; the plugin never restores a whole-file backup over those changes.
4. **Given** hypotheses, completed checks, and evidence classifications were checkpointed before context compaction, **When** the debug agent resumes, **Then** it restores the current phase and next action from the checkpoint and does not repeat a completed check unless newer evidence explicitly invalidates its conclusion.

---

### User Story 4 - Retain sanitized evidence intentionally (Priority: P3)

A developer investigating an intermittent issue explicitly asks to keep evidence. The plugin exports a sanitized evidence bundle and final report to a selected destination, then performs the normal ephemeral cleanup.

**Why this priority**: Retention is useful for difficult investigations but is not required to complete the default private, clean debugging workflow.

**Independent Test**: Complete a debug session with `keepArtifacts=true` and a destination, then verify that the retained bundle is sanitized and the original session directory and runtime resources are removed.

**Acceptance Scenarios**:

1. **Given** `keepArtifacts=false`, **When** any debug session ends, **Then** no evidence bundle is retained.
2. **Given** `keepArtifacts=true` and an explicit writable destination, **When** cleanup completes, **Then** the destination contains sanitized NDJSON evidence, a manifest without secrets, and the final report, while the ephemeral source directory is deleted.
3. **Given** retention was requested without a destination or export fails, **When** cleanup runs, **Then** the plugin reports the retention failure but still stops processes and the collector; it does not silently preserve the unsafe temporary directory indefinitely.

### Edge Cases

- The requested or randomly selected port is already in use, becomes unavailable during startup, or the listener closes unexpectedly.
- IPv4 loopback is available but IPv6 loopback is not, or vice versa; no fallback may bind a wildcard or LAN interface.
- Two OpenCode sessions debug the same project concurrently and must not share tokens, ports, manifests, log files, confirmation state, or cleanup ownership.
- Runtime input supplies a missing, malformed, oversized, unknown, expired, or path-like identifier.
- An HTTP client omits authentication, uses the wrong token, sends a disallowed method/content type, fails preflight, streams indefinitely, or exceeds request, event, field, or session limits.
- Evidence contains keys commonly associated with credentials, deeply nested objects, cycles, binary data, DOM nodes, huge arrays, or values that cannot be serialized.
- The disk becomes full, the temporary directory is not writable, or an evidence append is only partially completed.
- A hot loop floods the collector; probes must sample, aggregate, expose dropped-event counts, and avoid changing product behavior.
- Instrumentation causes parsing, type checking, compilation, linting, or build failure. Reproduction must not proceed until the owned instrumentation is repaired or removed.
- A browser extension uses Manifest V2 versus V3, `chrome.*`, `browser.*`, or a project wrapper, and may already possess loopback permission before debugging.
- A browser extension content script cannot contact loopback due to browser security or CSP. Its events must use extension messaging and a background relay.
- No events arrive after reproduction, the bug is not reproduced, or evidence is insufficient after three no-signal iterations.
- The failing process times out, ignores graceful termination, spawns descendants, exits before capture attaches, or emits invalid byte sequences.
- The root cause requires a larger redesign or a feature-disabling workaround rather than a minimal fix.
- The post-fix symptom disappears because instrumentation or a feature path masked it rather than because the confirmed cause changed.
- Cleanup is invoked more than once, during an in-flight request, after partial manual cleanup, or after the user moved/deleted an instrumented file.
- The working tree was dirty before debugging. Final verification must compare against the captured starting state rather than require a globally clean repository.
- The investigation checkpoint is missing, malformed, from an incompatible schema version, has a stale revision, or references evidence that was already removed.

## Requirements

### Functional Requirements

- **FR-001**: The package MUST register one selectable OpenCode agent named `debug` containing the complete hypothesis-driven debugging policy.
- **FR-002**: The package MUST register `/debug` as a shortcut that routes its arguments to the `debug` agent without duplicating the policy or tool orchestration.
- **FR-003**: Version 1 MUST activate only through explicit agent selection or `/debug`; it MUST NOT auto-activate on generic errors.
- **FR-004**: The agent MUST determine whether runtime Debug Mode is appropriate and offer a normal debugging path for a trivial, directly proven failure.
- **FR-005**: Before changing behavioral code, the agent MUST record expected behavior, actual behavior, target runtime, reproduction method, success criteria, and two to four ranked falsifiable hypotheses unless a single-cause runtime trace already proves the cause.
- **FR-006**: Every probe MUST reference a session, run label, hypothesis, stable probe identifier, message, timestamp, and source location.
- **FR-007**: The workflow MUST distinguish `pre-fix` and `post-fix` runs and classify each hypothesis as open, confirmed, or eliminated based on captured runtime evidence.
- **FR-008**: Static analysis MAY rank hypotheses but MUST NOT by itself be reported as runtime confirmation when Debug Mode was selected.
- **FR-009**: The agent MUST limit no-signal investigation to three iterations before offering a different approach, escalation, or abandonment.
- **FR-010**: The agent MUST apply only an evidence-backed, minimal fix and MUST identify feature-disabling or behavior-masking changes as workarounds requiring explicit approval.
- **FR-011**: The agent MUST run applicable regression, build, type-check, lint, or reproduction checks before declaring the fix verified.
- **FR-012**: The final report MUST state the outcome, root cause and deciding evidence, final hypothesis statuses, fix, changed files, verification results, retained-artifact location if any, and cleanup result.

- **FR-013**: The plugin MUST create an isolated debug session scoped from OpenCode's trusted tool-context session identifier rather than accepting a runtime-provided filesystem scope.
- **FR-014**: A session MUST own a cryptographically random internal identifier, bearer token, loopback port, state manifest, evidence store, process set, probe set, and lifecycle timestamps.
- **FR-015**: Concurrent sessions MUST remain isolated even when they target the same project or receive identical external labels.
- **FR-016**: The plugin MUST expose a stable structured tool set for session start/status, investigation-state read/checkpoint, process run-and-capture, probe registration, event reading/filtering, and cleanup.
- **FR-017**: Tool results MUST be machine-readable and include relevant session, run, hypothesis, probe, state, limit, and actionable error information.
- **FR-018**: The plugin MUST reject tool operations that attempt to act on resources not owned by the caller's OpenCode session.

- **FR-019**: The process backend MUST capture stdout, stderr, exit status, start/end time, duration, timeout, termination signal, and run label without requiring shell-specific syntax.
- **FR-020**: The process backend MUST support graceful termination followed by bounded forced termination of the owned descendant process tree on macOS, Linux, and Windows.
- **FR-021**: Process output MUST be bounded and streamed to the session evidence store so a noisy process cannot exhaust memory.
- **FR-022**: The agent MAY execute a deterministic CLI reproduction automatically but MUST ask before actions that require credentials, devices, external state changes, or materially different commands.

- **FR-023**: The HTTP collector MUST start only on demand for an active session and bind exclusively to an available IPv4 or IPv6 loopback address.
- **FR-024**: The collector MUST NOT fall back to a wildcard or LAN-accessible address when loopback binding fails.
- **FR-025**: The collector MUST expose only authenticated ingestion, authenticated minimal health, and the ingestion preflight behavior required by browsers; evidence listing, reading, and deletion MUST remain local plugin operations.
- **FR-026**: Ingestion MUST require the session bearer token, an allowed method, an allowed content type, and a payload conforming to the event schema.
- **FR-027**: The collector MUST reject invalid authentication and malformed input without revealing whether another session, probe, or artifact exists.
- **FR-028**: The collector MUST enforce the documented request-body, scalar-field, event-count, evidence-size, and idle-expiration limits and return structured limit errors without crashing.
- **FR-029**: CORS behavior MUST permit only ingestion-related methods and headers, MUST NOT use browser credentials, and MUST NOT expose readable evidence to an origin.
- **FR-030**: Runtime-provided identifiers MUST be validated against session-registered opaque identifiers and MUST never be concatenated into filesystem paths.
- **FR-031**: Evidence MUST be appended as structured NDJSON records and be filterable by session, run, hypothesis, probe, time range, and keyword.
- **FR-032**: Evidence persistence MUST redact common secret-bearing keys case-insensitively, truncate oversized values, bound nesting and collection samples, and record that redaction or truncation occurred.
- **FR-033**: The collector MUST count accepted, rejected, truncated, sampled, and dropped events so instrumentation overload is visible to the agent.
- **FR-034**: The plugin MUST send no telemetry and MUST perform no network communication other than user-authorized target commands and the session's loopback collector traffic.

- **FR-035**: JavaScript/TypeScript probes MUST use deterministic `DEBUG-START`/`DEBUG-END` marker blocks containing session, hypothesis, and probe ownership metadata.
- **FR-036**: The agent MUST add probes through normal source edits adapted to the target context; the plugin MUST track and validate the resulting marker content in the session manifest.
- **FR-037**: The plugin MUST provide safe probe payload and transport templates but MUST NOT inject unchecked arbitrary expressions or raw code solely by line number.
- **FR-038**: Before reproduction, the agent MUST verify that each instrumented target still parses or builds using the most relevant available project check.
- **FR-039**: Hot-path probes MUST support sampling, aggregation, bounded queues, and dropped-event summaries; blanket per-item instrumentation MUST be prohibited.
- **FR-040**: Browser-extension content scripts MUST relay through the extension's existing messaging style to a bounded background sender and MUST NOT fetch loopback directly.
- **FR-041**: Temporary extension permission changes MUST be tracked separately, MUST use valid loopback match patterns for the target manifest version, and MUST be removed only when the session added them.
- **FR-042**: Python or Go instrumentation MUST NOT be advertised as supported until generated probes compile and pass an end-to-end capture and cleanup test on all supported operating systems.

- **FR-043**: Normal completion MUST automatically stop owned processes and collectors, remove owned marker blocks and temporary permissions, delete tokens and ephemeral artifacts, rebuild or recheck cleaned targets, and inspect the working-tree delta for remaining debug artifacts.
- **FR-044**: Cleanup MUST also be attempted on cancellation, timeout, session deletion, plugin disposal, collector failure, and next-start orphan recovery after expiration.
- **FR-045**: Cleanup MUST be idempotent, bounded in time, and return a per-resource success, already-clean, skipped, or failed result.
- **FR-046**: Cleanup MUST remove only content whose session ownership and expected marker content match the manifest; it MUST NOT overwrite an entire source file from a backup.
- **FR-047**: If a marker changed unexpectedly, cleanup MUST preserve the ambiguous content, report its exact location, and continue cleaning other owned resources.
- **FR-048**: With default `keepArtifacts=false`, completion and abandonment MUST leave no session evidence, manifest, backup, token, listener, or child process.
- **FR-049**: With `keepArtifacts=true`, the plugin MUST require an explicit destination, export only sanitized evidence and the final report, remove the ephemeral source data, and clearly report export failures.
- **FR-050**: Startup orphan recovery MUST ignore active sessions and unrelated files and MUST operate only on verifiable expired manifests owned by this package.

- **FR-051**: The repository MUST be independently installable as the `opencode-debug-mode` npm package through OpenCode's supported plugin installation flow.
- **FR-052**: The repository MUST use the MIT license and include package metadata, README, SECURITY, CONTRIBUTING, architecture/lifecycle documentation, and CLI, web, Chrome-extension, and Firefox-extension examples.
- **FR-053**: Selectively ported source MUST retain required license and copyright notices and be documented in an attribution file; reference-only ideas MUST be identified separately from copied code.
- **FR-054**: Automated tests MUST cover agent/command registration, every public tool, process capture, HTTP ingestion, authentication, CORS, limits, path traversal, redaction, concurrent-session isolation, cleanup, orphan recovery, and default artifact deletion.
- **FR-055**: Every advertised probe adapter MUST have syntax or compilation tests plus end-to-end instrumentation, capture, verification, and cleanup tests.
- **FR-056**: Continuous integration MUST run supported checks on macOS, Linux, and Windows against the declared Node.js and OpenCode compatibility range.
- **FR-057**: Every active debug session MUST persist a versioned `investigation-state.json` checkpoint in its isolated temporary directory; model conversation context MUST NOT be the sole source of investigation state.
- **FR-058**: The checkpoint MUST contain the problem summary, expected and actual behavior, runtime and reproduction context, success criteria, current workflow phase, loop iteration, hypotheses and statuses, completed checks and interpretations, runs and probe references, deciding evidence identifiers, developer confirmations, decisions, next action, instrumented and fixed files, and cleanup progress.
- **FR-059**: The checkpoint MUST store concise conclusions and stable references to NDJSON evidence; it MUST NOT duplicate raw evidence payloads, complete command output, source contents, conversation transcripts, or bearer tokens.
- **FR-060**: The agent MUST checkpoint after every meaningful state transition, including hypothesis creation or status change, completed check, instrumentation change, reproduction confirmation, evidence analysis, fix decision, verification result, and cleanup transition, and immediately before waiting for user input.
- **FR-061**: The agent MUST read and reconcile the checkpoint before the first action of every resumed turn and after context compaction, task continuation, or OpenCode restart. A completed check MAY be repeated only when the checkpoint records the new evidence or changed condition that invalidated the earlier conclusion.
- **FR-062**: Checkpoint updates MUST be atomic, schema-validated, monotonically revisioned, scoped to the trusted OpenCode session, and protected against stale or concurrent writes.
- **FR-063**: A missing, incompatible, or invalid checkpoint MUST produce an explicit recovery result. The plugin MAY reconstruct verifiable runtime facts from the manifest and evidence store but MUST NOT invent lost conclusions or silently restart the investigation from scratch.
- **FR-064**: The checkpoint MUST follow the same redaction, retention, export, and cleanup rules as other session artifacts. With `keepArtifacts=true`, the exported checkpoint MUST be sanitized and contain no token or unsanitized payload.

### Key Entities

- **Debug Session**: An isolated investigation associated with one trusted OpenCode session. It owns lifecycle state, token, collector, processes, runs, probes, manifests, evidence limits, retention choice, and cleanup status.
- **Investigation State**: A compact, versioned, revisioned checkpoint that preserves meaningful checks, conclusions, evidence references, workflow position, and next action independently of the model context.
- **Hypothesis**: A ranked falsifiable explanation with confirmation and elimination signals and a status of open, confirmed, or eliminated.
- **Run**: One baseline or verification attempt, labeled `pre-fix` or `post-fix`, with reproduction confirmation, timing, process result, and correlated evidence.
- **Probe**: A minimal session-owned instrumentation point linked to one hypothesis and source location, including expected marker content and sampling policy.
- **Evidence Event**: A validated, bounded, sanitized runtime observation containing event time, run, hypothesis, probe, message, data, and source location.
- **Collector**: A session-owned loopback ingestion service with an address, secret token, limits, health state, activity timestamps, and event counters.
- **Owned Process**: A command and descendant process tree started by the plugin, including capture state and termination outcome.
- **Cleanup Manifest**: The authoritative inventory and expected ownership fingerprints for probes, permission changes, processes, collector, and temporary artifacts.
- **Retained Evidence Bundle**: An optional user-requested sanitized export containing NDJSON evidence and the final report but no bearer token, unsanitized payload, or ephemeral ownership data.

## Success Criteria

### Measurable Outcomes

- **SC-001**: In clean test environments on macOS, Linux, and Windows, 100% of supported OpenCode versions can install the package and expose both the selectable `debug` agent and `/debug` command without manual file copying.
- **SC-002**: The reference CLI fixture completes the full hypothesis, baseline, fix, post-fix comparison, and cleanup journey with a correct evidence-backed root cause in one uninterrupted session.
- **SC-003**: The reference browser and extension fixtures complete human-reproduced HTTP collection without requiring the user to copy logs, inspect ports, check health endpoints, or operate collector tooling.
- **SC-004**: A collector becomes ready or returns an actionable startup failure within 2 seconds under normal local conditions and never listens on a non-loopback interface.
- **SC-005**: Invalid tokens, path-like identifiers, oversized requests, disallowed methods, malformed events, and cross-session access attempts are rejected in 100% of security test cases without creating or modifying files outside the owning session directory.
- **SC-006**: Evidence volume remains within configured request, field, event, and file limits under stress fixtures, while accepted, rejected, sampled, truncated, and dropped counts reconcile with the generated workload.
- **SC-007**: Normal cleanup completes within 5 seconds after in-flight requests and processes settle, and leaves zero listeners, owned processes, tokens, temporary permissions, marker blocks, manifests, logs, or backups.
- **SC-008**: Cancellation, timeout, disposal, and crash-recovery tests leave zero verifiable orphan resources after cleanup or next startup, with partial failures reported rather than hidden.
- **SC-009**: Cleanup preserves 100% of unrelated pre-existing and concurrent user edits in adversarial dirty-working-tree tests.
- **SC-010**: Every advertised language adapter passes syntax or compilation and end-to-end capture/cleanup tests on all three operating systems; unsupported adapters are absent from documentation and capability reports.
- **SC-011**: With default settings, no debug evidence or telemetry leaves the local machine and no debug artifact remains after successful, unresolved, abandoned, or escalated session termination.
- **SC-012**: With explicit retention, the exported bundle contains no configured secret-bearing values or bearer token in the security fixture and the original ephemeral session directory is deleted.
- **SC-013**: In forced-compaction and resumed-task tests at every workflow phase, the agent restores the correct phase, hypothesis statuses, completed checks, and next action from the checkpoint before issuing another mutating or runtime tool call.
- **SC-014**: In resumed-task tests, 100% of completed conclusive checks are not repeated unless the state records a specific invalidating change or newer conflicting evidence.
- **SC-015**: The checkpoint remains at or below 256 KiB in stress scenarios, contains no raw evidence payloads or bearer token, and is deleted by default cleanup or sanitized during explicit export.
