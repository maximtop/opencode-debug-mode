# Real OpenCode behavioral acceptance

The behavioral harness runs the local plugin through a real OpenCode 1.18.3 server. Its primary profile is a deliberately small deterministic CLI bug, so failures measure the debug-agent workflow instead of the model's ability to navigate the Browser Extension repository.

The release gate is two consecutive unchanged passes of the primary profile with `tokenguard/deepseek-v4-flash`, variant `high`. AG-55256 remains a larger secondary smoke test.

## Primary profile: synthetic CLI

Run one fresh acceptance session:

```sh
node --experimental-strip-types scripts/opencode-behavioral-acceptance.ts
```

The disposable project is copied from `fixtures/feature-flag-bug` and committed as a fresh local Git baseline. It contains one async feature-flag lookup, one data file, and one test. Account `team/acme` should load `data/team%2Facme.json`, but the baseline uses the wrong URL encoder and returns `false` after `readFile` rejects with `ENOENT`.

The agent is not told the cause. It must autonomously:

1. show and checkpoint two to four falsifiable hypotheses;
2. reproduce the failing `npm test` path with registered process probes around the may-fail `readFile` boundary;
3. read persisted runtime evidence and make the evidence decision visible;
4. apply only the evidence-backed `encodeURI` to `encodeURIComponent` correction;
5. rerun the same test as a distinct post-fix verification;
6. call `debug_cleanup`, remove all temporary instrumentation, and reach idle without asking a question.

The external evaluator accepts only that one-line behavioral diff. This is a test assertion, not a model-facing gate. The plugin still receives only its normal agent prompt and public tools.

## Secondary profile: AG-55256

Run the Browser Extension smoke test explicitly:

```sh
node --experimental-strip-types scripts/opencode-behavioral-acceptance.ts \
  --profile ag-55256
```

This profile clones the sibling `../browser-extension` repository at detached commit `3db0d614806984803cc4d5976fd64d78917999f2`, prepares it with `pnpm install --frozen-lockfile --ignore-scripts`, and stops at the first prepared human reproduction `Question`. It checks investigation quality and safe instrumentation on a realistic large repository; it does not replace the deterministic primary gate.

## Isolation and options

Both profiles use:

- `~/.opencode/bin/opencode`, required to report version `1.18.3`;
- the locally built `dist/index.js` and matching `assets/debug-agent.md`;
- model `tokenguard/deepseek-v4-flash`, variant `high`;
- invocation-owned config, data, state, cache, home, repository, and temporary directories.

The isolated config is projected from `~/.config/opencode/opencode.jsonc`: it copies only the selected provider definition and matching default model fields. It never copies global plugins, agents, MCP servers, or permissions, and it rejects inline provider credentials. The isolated `auth.json` contains only the selected provider's authentication entry.

Projected permissions deny external directories, externally classified debug processes, `git push`/`commit`/`tag`, `gh`, `bb`, and npm/pnpm/yarn publication. The disposable repository has no remote and ignores user and system Git configuration.

Use `--help` for profile, path, model, prompt, preparation, and output overrides. Every output directory must be new. The model run has no overall deadline and continues until a terminal OpenCode event or manual interruption. Short deadlines remain only on individual SDK, process-capture, startup, preparation, and cleanup operations so one I/O operation cannot hang indefinitely.

## Artifacts and cleanup

The retained `.opencode-debug-mode/acceptance/<timestamp>/` report contains:

- the profile ID, requested model and variant, fixture tree hash or source commit, OpenCode version, local plugin URL, package version, and prompt hash;
- ordered tool calls and assistant transcript, excluding hidden reasoning;
- the OpenCode session diff and repository diff/status;
- sanitized plugin state and evidence when still present at the capture point;
- a redacted server log and every acceptance check.

Only the selected provider entry is written to isolated `auth.json`, with mode `0600`. SSH, GitHub, npm, cloud, password, secret, cookie, credential, and token-shaped environment variables are removed before OpenCode starts. The harness never reads or exports the plugin's `secret.bin`.

The temporary server, repository, copied authentication, and plugin runtime state are removed in `finally`. Cleanup removes only the unique temporary root created by that invocation. In the synthetic profile, the intended one-line fix remains visible in the captured disposable-repository diff while every owned probe and runtime directory must be gone.

## Interpretation

A synthetic PASS shows that the selected model can follow the complete Debug Mode protocol on a small, fully observable task. If Flash passes the synthetic profile but struggles on AG-55256, repository size and problem context are the likely constraint. If Flash repeatedly fails the synthetic profile while a stronger model passes the same unchanged fixture and prompt, model capability is the likely constraint.

Neither profile proves general debugging ability. The synthetic profile is the stable protocol regression; AG-55256 is the realistic context smoke test.
