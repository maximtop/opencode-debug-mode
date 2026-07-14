# opencode-debug-mode

`opencode-debug-mode` is an explicit, hypothesis-driven runtime debugging agent for OpenCode. It registers a selectable `debug` primary agent, the `/debug` command, and a bounded structured tool surface for CLI, web, and browser-extension investigations.

## Requirements

- OpenCode 1.17 or any compatible 1.x release
- Node.js 20 or newer
- An npm-compatible OpenCode plugin installation

## Install

Install the package in the environment where OpenCode resolves plugins, then add its npm name to the normal OpenCode configuration:

```json
{
  "plugin": ["opencode-debug-mode"]
}
```

Restart OpenCode, select the `debug` agent or run `/debug describe the runtime failure`. No agent or command files need to be copied.

## Workflow

The agent records scope and two to four falsifiable hypotheses, captures a failing `pre-fix` baseline, adds the smallest owned probe, analyzes correlated evidence, applies only the confirmed fix, creates a distinct `post-fix` run, and cleans every owned resource. Durable revisioned state allows the workflow to resume after compaction or restart without repeating conclusive checks.

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

## Uninstall

Finish or abandon active investigations so cleanup can run, remove `opencode-debug-mode` from the OpenCode `plugin` list, uninstall the npm package, and restart OpenCode.

## License

MIT. See `LICENSE`.
