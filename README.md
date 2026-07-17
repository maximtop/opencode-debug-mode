# opencode-debug-mode

`@maximtop/opencode-debug-mode` is an explicit, hypothesis-driven runtime debugging agent for OpenCode. It registers a selectable `debug` primary agent, the `/debug` command, and a bounded structured tool surface for CLI, web, and browser-extension investigations.

## Requirements

- OpenCode 1.17 or any compatible 1.x release
- Node.js 20 or newer
- An npm-compatible OpenCode plugin installation

## Install

Install the package from the public npm registry in the environment where OpenCode resolves plugins:

```sh
npm install @maximtop/opencode-debug-mode
```

Then add its npm name to the normal OpenCode configuration:

```json
{
  "plugin": ["@maximtop/opencode-debug-mode"]
}
```

Restart OpenCode, select the `debug` agent or run `/debug describe the runtime failure`. No agent or command files need to be copied.

## Workflow

The agent visibly presents two to four ranked falsifiable hypotheses, records them with the scope, captures a failing `pre-fix` baseline, adds the smallest owned probe set that distinguishes them, and shows the evidence decision before applying only the confirmed fix. A potentially failing operation is observed before and after so downstream silence is not mistaken for a diagnosis. It then creates a distinct same-path `post-fix` run and cleans every owned resource. Durable revisioned state allows the workflow to resume after compaction or restart without repeating conclusive checks.

Executable lifecycle gates protect mutation, evidence, verification, and cleanup boundaries. Debug Mode blocks ordinary behavioral edits until a completed pre-fix run reproduced the issue, a confirmed hypothesis references persisted runtime evidence, and the intended file scope is checkpointed. A completed report additionally requires persisted post-fix evidence showing that the same symptom no longer reproduces. Human-reproduced baselines require corresponding human post-fix verification. Prompt policy and the [real OpenCode behavioral harness](docs/behavioral-acceptance.md) separately test investigation quality. Its primary fixture is intentionally small enough to distinguish protocol/model failures from large-repository context pressure; AG-55256 remains a secondary realistic smoke test.

Safe local investigation and temporary instrumentation proceed autonomously. The agent asks the developer only for an undiscoverable blocker, required external authorization, or a prepared human checkpoint: after instrumentation it may ask whether the issue reproduced, and after the evidence-backed fix and automated checks it may ask whether the same reproduction is now fixed. It never asks the developer to select a speculative fix instead of collecting evidence.

When a bounded code read disproves a provisional hypothesis, the agent checkpoints the corrected slate and shows its fresh receipt before instrumentation. Browser and extension reproduction Questions include the checked-in build command, the exact artifact to reload, and the original in-application steps.

The first scope checkpoint preserves the reported runtime boundary. A provided browser, extension, device, or external-state procedure is recorded with `reproduction.requiresUser=true`. The value may be `false` only when an existing supervised command already reproduces the exact same runtime symptom across the same relevant boundary; a local Node, fetch, mock, fixture, or test approximation is not equivalent. After the first baseline run starts, `true` can never become `false`. A mistaken `false` can become `true` only when every run is terminal and a new hypothesis iteration starts before deciding evidence or any behavioral fix.

CLI targets run below a watchdog supervisor. Web targets use an authenticated server bound only to loopback. Extension content scripts relay through the existing messaging style; only the background helper can reach loopback.

See the runnable patterns in:

- `examples/cli`
- `examples/web`
- `examples/chrome-extension`
- `examples/firefox-extension`

## Privacy, retention, and cleanup

The default is `keepArtifacts=false`. Evidence, state, credentials, manifests, helpers, probes, permissions, listeners, and owned processes are removed on completion or abandonment. Nothing is uploaded and the package emits no telemetry.

Explicit retention requires a destination. The exported bundle contains sanitized NDJSON evidence, a sanitized checkpoint, a report, and public hashes. It never includes the bearer credential, internal cleanup manifest, raw environment, or ephemeral path inventory.

Cleanup removes only byte-for-byte owned marker blocks, exact-hash helper files, and extension permissions added by the active session. Ambiguous user-edited content is preserved and reported as partial cleanup.

## Limits

- 64 KiB per collector request and 100 events per batch
- 8 KiB control/scalar values
- 25,000 events and 25 MiB evidence per session
- 256 KiB durable checkpoint
- 30-minute idle expiry, suppressed only by a process or explicit reproduction-wait lease
- Three no-signal investigation iterations

## v1 boundaries

Generated probes target JavaScript and TypeScript only. The two transports are supervised process capture and authenticated loopback HTTP ingestion. There is no evidence-reading HTTP endpoint, remote collector, debugger-protocol backend, or automatic activation.

## Troubleshooting

- If startup reports a bind error, verify local software is not denying both IPv4 and IPv6 loopback sockets.
- If a probe cannot register, reapply the exact marker returned by the preparation tool and retry the project parse/type/build check.
- If cleanup is partial, preserve the reported marker or permission and review it manually; unrelated edits are intentionally never overwritten.
- If a checkpoint is invalid or incompatible, follow the explicit recovery result rather than restarting the investigation silently.
- OpenCode does not hot-reload an npm plugin into an already running server. After upgrading, close every OpenCode window/server for that workspace and start it again. The first `debug_session_start` result reports the loaded package version and prompt SHA-256; use those values to detect a stale process.

## Uninstall

Finish or abandon active investigations so cleanup can run, remove `@maximtop/opencode-debug-mode` from the OpenCode `plugin` list, uninstall the npm package, and restart OpenCode.

## License

MIT. See `LICENSE`.
