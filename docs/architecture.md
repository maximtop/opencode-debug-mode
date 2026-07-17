# Architecture

The package exports one OpenCode plugin. Its config hook installs the `debug` primary agent and routing-only command. Every public tool derives ownership from `ToolContext.sessionID`; public arguments cannot select a different session.

Each session receives a random directory under the package OS-temporary base. The strict revisioned manifest inventories runs, processes, collectors, markers, helper hashes, permission entries, counters, and cleanup progress. The separate strict checkpoint stores conclusions and stable evidence references. A serialized NDJSON writer stores sanitized evidence within event and byte limits.

The debug agent is reinforced by executable lifecycle gates. A tool hook permits pre-fix edits only when they are the exact marker block prepared for a planned probe. Behavioral edits require an accepted `fixing` checkpoint, a completed reproduced pre-fix run, persisted evidence tied to a confirmed hypothesis, an explicit decision, and a fixed-file scope. Completed cleanup requires a same-path post-fix run with persisted evidence; human baselines require human verification. Each run is explicitly closed with its observed issue outcome.

Session start and status expose the loaded package version and prompt SHA-256, and plugin initialization logs the same fingerprint. This makes long-lived OpenCode processes with stale in-memory plugin code diagnosable.

CLI capture forks a package-owned Node supervisor over IPC. The supervisor starts the target detached without a shell, forwards bounded streams, and kills the descendant tree on timeout, explicit termination, or parent disconnect.

Web and extension-background capture uses a Node HTTP server bound explicitly to `127.0.0.1`, with `::1` as the only availability fallback. Exact routes provide authenticated ingestion and minimal health. The per-session credential never appears in tool output.

Probe preparation produces deterministic JS/TS marker blocks. Web/background credentials exist only in a newly created exact-hash helper. Extension content probes use messaging and never fetch loopback directly.

Cleanup drains the collector, terminates processes, removes exact markers, removes session-added permissions and exact-hash helpers, runs an optional clean check, optionally stages a sanitized bundle, removes the secret, and deletes the ephemeral directory. Each resource reports success, already-clean, skipped, or failed.

Future transports should implement the conceptual `EvidenceBackend` boundary—start, ingest/capture, status, and cleanup—without changing the canonical event, ownership, state, or tool contracts. v1 intentionally has no backend registry.
