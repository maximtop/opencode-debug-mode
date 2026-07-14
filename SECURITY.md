# Security policy

## Threat model

Runtime evidence and target processes are untrusted. Loopback is a network boundary, not authentication: every data/health request requires a random 256-bit bearer credential. Only a minimal unauthenticated CORS preflight is allowed. The collector never exposes evidence reading or deletion over HTTP.

Credentials live only in mode-0600 ephemeral storage, collector memory, and an exact-hash-owned background/web helper. They are excluded from manifests, checkpoints, tool results, logs, reports, and retained bundles. Authentication compares fixed-length digests.

Input bodies, headers, schemas, IDs, paths, strings, collections, event counts, files, and queues are bounded. Evidence is recursively sanitized with deterministic secret-key redaction before persistence. Runtime IDs never become path components.

Commands use executable/argument arrays with no shell. The watchdog terminates descendant trees if the parent disappears. Commands involving credentials, devices, external state, materially different actions, or external directories require OpenCode permission approval.

Cleanup owns exact marker bytes, helper hashes, and individual permission entries; it never restores a whole source file. Ambiguous changes are preserved and reported. Explicitly retained evidence remains sensitive even after sanitization and should receive the same access controls as source code.

## Reporting a vulnerability

Use the repository's GitHub private vulnerability reporting feature. Do not open a public issue containing a credential, exploit, or captured evidence. Include affected versions, reproduction conditions, impact, and a minimal proof without real user data.
