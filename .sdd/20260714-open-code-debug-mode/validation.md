# Validation Report: OpenCode Debug Mode

**Validated**: 2026-07-14
**Model**: GPT-5 Codex, high reasoning effort
**Spec**: `.sdd/20260714-open-code-debug-mode/spec.md`
**Plan**: `.sdd/20260714-open-code-debug-mode/plan.md`

## Summary

| Category | Pass | Partial | Fail | N/A | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tasks | 33 | 0 | 0 | 0 | 33 |
| Requirements | 64 | 0 | 0 | 0 | 64 |
| Entities | 10 | 0 | 0 | 0 | 10 |
| Contracts | 3 | 0 | 0 | 0 | 3 |
| Guidelines | 2 | 0 | 0 | 5 | 7 |
| Success Criteria | 15 | 0 | 0 | 0 | 15 |

**Overall Status**: COMPLETE

All findings from the previous validation are fixed. The implementation, local compatibility tests, coverage gates,
package audit, packaging commands, and the complete hosted CI matrix pass. GitHub Actions run
`29316687531` succeeded on macOS, Ubuntu, and Windows with Node.js 20 and 22; its `quality` and `opencode-compat` jobs
also passed.

## Verification Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `npm ci && npm run check` | PASS | Clean install; 95 unit tests, build, and 23 integration tests passed. Integration includes packed installs through the real OpenCode CLI on 1.17.0 and current 1.x (1.17.19). |
| `npm run coverage` | PASS | 55 files and 132 tests passed. Statements 90.31%, branches 85.02%, functions 90.54%, lines 92.95%; all configured gates passed. |
| `npm run test:e2e` | PASS | 5 files and 14 tests passed, including CLI, real web fixture, Chrome MV3, Firefox MV2, every public tool, and all nine resume phases. |
| `npm pack --dry-run` | PASS | 71 publishable files; source, tests, fixtures, coverage, `.sdd`, and ephemeral artifacts are excluded. |
| Placeholder scan | PASS | No unresolved placeholder patterns in the plan or contracts. |
| `npm audit --audit-level=low` | PASS | Zero known vulnerabilities after pinning the fixed esbuild release. |
| Hosted OS matrix | PASS | GitHub Actions run `29316687531`: all eight jobs passed, including macOS/Ubuntu/Windows on Node.js 20/22, `quality`, and packed OpenCode compatibility; no publish step exists. |

The fork-only `src/process/supervisor-entry.ts` is excluded from in-process V8 accounting because Vitest cannot merge
coverage from the supervised child process. Its behavior remains covered by real IPC integration tests, including
parent disconnect and descendant termination. Coverage thresholds were not lowered.

## Task Status

- [x] **Tasks 1–6**: PASS — package, contracts, isolated storage, atomic manifest/checkpoint, and shared sanitizer are implemented and covered.
- [x] **Tasks 7–9**: PASS — bounded NDJSON, durable counters, full filtering, run/probe ownership, rehydration, leases, expiry, and cleanup are verified.
- [x] **Tasks 10–14**: PASS — decoder/protocol, graceful and forced process-tree termination, watchdog, capture, timeout, output bounds, and approval paths pass.
- [x] **Tasks 15–19**: PASS — credentials, loopback-only binding, exact routing/CORS, malformed/oversized ingestion, sampling/dropping, activity touch, and failure cleanup pass.
- [x] **Tasks 20–25**: PASS — safe adapters/helpers, exact marker removal, MV2/MV3 permission ownership, sanitized retention, idempotent cleanup, and contained orphan recovery pass.
- [x] **Tasks 26–28**: PASS — all 11 tools execute through the composed plugin, lifecycle hooks clean resources, and the single durable agent policy maps to the requirements.
- [x] **Tasks 29–32**: PASS — actual CLI/web/Chrome/Firefox journeys, forced compaction/resume, security/stress suites, and OSS/package documentation pass.
- [x] **Task 33**: PASS — the final audit, lower-bound/current OpenCode packed installs, and the macOS/Ubuntu/Windows Node.js 20/22 hosted matrix all pass.

## Requirement Status

The complete one-row-per-requirement trace is in `.sdd/20260714-open-code-debug-mode/requirement-matrix.md`.

| ID | Status | Evidence |
| --- | --- | --- |
| FR-001..012 | IMPLEMENTED | `src/plugin.ts`, `assets/debug-agent.md`, agent/registration/CLI E2E tests. |
| FR-013..018 | IMPLEMENTED | Trusted registry plus all-public-tool success, ownership, stale-state, unsafe-path, and approval matrices. |
| FR-019..022 | IMPLEMENTED | Real supervisor/capture/timeout/forced-tree tests and structured approval tool tests. |
| FR-023..034 | IMPLEMENTED | Loopback server, auth/router/ingest/evidence modules; route/body/filter/sampling/drop/security tests. |
| FR-035..042 | IMPLEMENTED | Restricted captures, four JS/TS transports, generated helper, exact markers, permission integration, and web/extension E2E tests. |
| FR-043..050 | IMPLEMENTED | Per-resource cleanup, retained path/sanitization, idle/dispose/delete/failure cleanup, and canonical orphan containment tests. |
| FR-051..055 | IMPLEMENTED | Packed real-CLI installs, MIT/OSS contents, attribution, passing coverage gates, and JS/TS fixture checks. |
| FR-056 | IMPLEMENTED | `.github/workflows/ci.yml` runs the required OS/Node/compatibility jobs without publishing; GitHub Actions run `29316687531` passed every job. |
| FR-057..064 | IMPLEMENTED | Strict bounded checkpoint, recovery results, compaction hook, nine-phase resume suite, conclusive-check preservation, cleanup, and sanitized retention. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Debug Session | OK | OK | Trusted context, random scope, canonical paths, lifecycle ownership | PASS |
| Investigation State | OK | OK | Strict schema, CAS, byte bound, recovery outcomes | PASS |
| Hypothesis | OK | OK | Rank/status/evidence and resume preservation | PASS |
| Run | OK | OK | Generated identity, label/status/reproduction and manifest/state correlation | PASS |
| Probe | OK | OK | Safe captures, exact marker/helper/permission ownership | PASS |
| Evidence Event | OK | OK | Strict schema, registered correlation, sanitization, bounded NDJSON | PASS |
| Collector | OK | OK | Loopback/auth/routes/activity/counters/failure cleanup | PASS |
| Owned Process | OK | OK | Supervisor/target ownership, result evidence, bounded termination | PASS |
| Cleanup Manifest | OK | OK | Strict atomic inventory plus canonical recovery-time reference checks | PASS |
| Retained Evidence Bundle | OK | OK | Exact allowlist, hashes, sanitized state/evidence/report, secret scan | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| `/v1/events` | `OPTIONS` | PASS | Ingestion-only preflight, bounded origin/headers, no credentials. |
| `/v1/events` | `POST` | PASS | Authenticated JSON only; request/batch/event/field/session limits, ownership, sampling, dropping, and generic errors verified. |
| `/v1/health` | `GET` | PASS | Authenticated minimal ready/draining response; no evidence exposure. |

All 11 OpenCode tools return the stable JSON envelope and were exercised through the composed plugin. Error matrices
cover no-session ownership, duplicates, stale revisions, unsafe sources, missing markers, approval denial, and internal
error containment.

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Prefer simple data access | COMPLIANT | Validation used local files, npm metadata, direct commands, and structured test output. |
| Internal Jira access | N/A | No Jira item was referenced. |
| Notion access | N/A | No Notion operation was requested. |
| Codex CLI update checks | N/A | No Codex CLI update was performed. |
| Commit titles | COMPLIANT | Repository commits use sentence-case titles without Conventional Commits prefixes. |
| Pull request descriptions | N/A | No pull request was created or edited. |
| Pull request triple-dot diffs | N/A | No pull request was reviewed or applied. |

## Success Criteria Status

| ID | Status | Evidence |
| --- | --- | --- |
| SC-001 | MET | Packed plugin installs and loads through real OpenCode 1.17.0 and current 1.x locally; the macOS/Ubuntu/Windows Node.js 20/22 CI matrix passes. |
| SC-002 | MET | Real CLI baseline, probe evidence, minimal fix, post-fix comparison, hypothesis report, and cleanup. |
| SC-003 | MET | Actual web/Chrome/Firefox fixture execution, generated transport/relay, automatic events, permission cleanup, and cleaned syntax checks. |
| SC-004 | MET | Random loopback startup under two seconds and explicit-host-only tests. |
| SC-005 | MET | Auth, path, method, content-type, body, event, ownership, and external-path rejection matrices pass. |
| SC-006 | MET | Request/scalar/event/file limits and accepted/rejected/sampled/truncated/dropped counter paths are verified and reconcile. |
| SC-007 | MET | Collector/process/marker/helper/permission/secret/session cleanup, timeout, idempotency, and artifact scans pass. |
| SC-008 | MET | Timeout, parent disconnect, disposal, deletion, idle expiry, collector failure, and restart recovery are covered with partial-failure reporting. |
| SC-009 | MET | Changed/duplicate/missing markers, concurrent surrounding edits, unrelated files, and permission edits are preserved conservatively. |
| SC-010 | MET | All advertised JS/TS adapters pass syntax, capture, and cleanup checks locally and across the three-OS hosted matrix. |
| SC-011 | MET | No telemetry path exists; default completion/abandonment lifecycle tests remove owned artifacts. |
| SC-012 | MET | Explicit retained bundle is sanitized, exact-secret scanned, reported, and source session is removed. |
| SC-013 | MET | Nine workflow phases invoke compaction guidance and restore state before the next tool action. |
| SC-014 | MET | Completed conclusive checks and hypothesis status survive every resumed phase without repetition. |
| SC-015 | MET | Checkpoint schema/size/recovery tests pass; default cleanup deletes it and retained export sanitizes it. |

## Issues Found

No unresolved implementation or validation issues were found.

## Recommendations

- Keep the 90/90/90/85 coverage gates and the packed lower-bound/current OpenCode compatibility job required for changes.
- Update GitHub-maintained actions when stable releases remove the runner warning about their deprecated Node.js 20 action runtime; this warning does not affect the project Node.js 20/22 matrix.
