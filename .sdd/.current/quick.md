# Implementation Plan: Allow Questions in Debug Mode

**Created**: 2026-07-15
**Status**: Implemented
**Model**: GPT-5 Codex, high reasoning effort
**Implemented by**: GPT-5 Codex, high reasoning effort
**Type**: Bug Fix
**Input**: On OpenCode 1.18.1, make the plugin's custom `debug` primary agent able to use the structured `question` tool while preserving the default denial of plan-mode transitions. Release the fix as `v0.1.1`.

## Problem

OpenCode 1.18.1 resolves the plugin's `debug` agent with `question: deny`, so the Tool Permissions screen shows Question as denied and the structured question tool is unavailable. The plugin currently registers the custom agent without a permission override, causing it to inherit OpenCode's restrictive custom-agent default.

## Research Findings

The installed OpenCode 1.18.1 executable resolves the current agent to a final `question` deny rule and reports `tools.question` as `false`. OpenCode merges an agent's explicit permission configuration after its defaults, so the smallest compatible fix is an agent-local `permission: { question: "allow" }` override. Omitting `plan_enter` and `plan_exit` preserves their default deny rules.

The package already accepts OpenCode 1.x from `1.17.0` through the peer range `>=1.17.0 <2`; no runtime dependency change is required. The existing packed-install integration helper is the right place to prove the final behavior after OpenCode has merged defaults and plugin configuration.

OpenCode's generated 1.x `Config` type still enumerates only legacy permission keys even though the runtime accepts arbitrary permission names. A typed `Record<string, "allow" | "ask" | "deny">` intermediate documents and contains that compatibility gap without weakening the surrounding plugin configuration type.

### Root Cause

`src/plugin.ts` sets the debug agent's mode, description, and prompt but does not define permissions. OpenCode therefore applies the custom-agent default `question: deny`.

### Patterns to Follow

- Scope the override to `config.agent.debug`; do not change global permissions.
- Explicitly allow only `question`.
- Keep `plan_enter` and `plan_exit` absent from the plugin override so OpenCode continues to deny them.
- Test both the plugin-authored configuration and OpenCode's fully resolved agent.
- Keep the existing lower-bound compatibility check and update the current-version check to OpenCode 1.18.1.

### Edge Cases

- Existing user or project configuration named `agent.debug` is intentionally replaced, so the plugin's permission must be deterministic after a collision.
- Allowing `question` must not accidentally enable either plan transition tool.
- OpenCode 1.17.0 must continue to install and register the package.
- The release tag must match `package.json` exactly and must be created only after `master` CI succeeds.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `tests/unit/plugin-registration.test.ts` | Modify | Assert the plugin writes only the intended question permission override. |
| `tests/helpers/open-code.ts` | Modify | Read the fully resolved debug agent permissions and tool availability from a packed install. |
| `tests/integration/opencode-install.test.ts` | Modify | Cover OpenCode 1.17.0 and 1.18.1 and assert resolved permission behavior. |
| `src/plugin.ts` | Modify | Allow the debug agent to invoke the structured question tool. |
| `package.json` | Modify | Bump the release version to 0.1.1. |
| `package-lock.json` | Modify | Keep lockfile package metadata aligned with 0.1.1. |

## Solution

First add regression assertions that fail against the current plugin. Then add the single agent-level permission override. Exercise a locally packed tarball with OpenCode 1.18.1 to verify the merged result: Question is allowed and available, while Plan Enter and Plan Exit remain denied. Run the complete quality and end-to-end suites, bump to 0.1.1, publish the green `master` commit and annotated `v0.1.1` tag, then verify GitHub Release and npm provenance.

## Tasks

### [x] Task 1: Add failing permission regression coverage

**Files:**
- Modify: `tests/unit/plugin-registration.test.ts`
- Modify: `tests/helpers/open-code.ts`
- Modify: `tests/integration/opencode-install.test.ts`

- [x] Assert that the plugin-authored debug agent contains exactly `permission: { question: "allow" }`.
- [x] Extend the packed-install helper to run `opencode debug agent debug` and expose the last matching `question`, `plan_enter`, and `plan_exit` actions plus `tools.question`.
- [x] Change the default compatibility versions to `1.17.0` and `1.18.1`, then assert Question is allowed/available and both plan transitions remain denied.
- [x] Run the focused tests before the source fix and record the expected failure.

**Verification**: The new regression assertion fails because the current debug agent has no permission override and OpenCode resolves Question as denied.

Implementation note: both focused tests failed before the source change. The unit test found no permission override, and OpenCode 1.18.1 resolved `question: deny` while retaining both plan denials.

### [x] Task 2: Apply the minimal agent permission fix

**Files:**
- Modify: `src/plugin.ts`

- [x] Add `permission: { question: "allow" }` to `config.agent.debug` without adding any plan permission.
- [x] Run the focused unit and packed-install integration tests.

**Verification**: Both layers report Question allowed; the resolved OpenCode agent still reports Plan Enter and Plan Exit denied.

Implementation note: the focused unit test and packed-install tests pass. OpenCode 1.17.0 and 1.18.1 both resolve Question to allow, expose the question tool, and leave Plan Enter and Plan Exit denied.

### [x] Task 3: Validate and prepare patch version

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] Run `npm run check`.
- [x] Run `npm run test:e2e`.
- [x] Bump 0.1.0 to 0.1.1 with the SDD bump-version workflow.
- [x] Run `npm pack --dry-run` and `npm publish --dry-run`.

**Verification**: All automated checks pass and the packed public artifact reports version 0.1.1.

Implementation note: `npm run check` passes 116 unit and 23 integration tests, `npm run test:e2e` passes 14 tests, and both npm dry runs report the public package as `@maximtop/opencode-debug-mode@0.1.1`. The project intentionally has no changelog; release notes remain generated by GitHub as defined by the release contract.

### [x] Task 4: Prepare the v0.1.1 release handoff

**Files:**
- Modify: `.sdd/.current/quick.md`

- [x] Confirm the repository is public, its default branch is `master`, and local `HEAD` matches `origin/master` before the release commit.
- [x] Confirm tag, GitHub Release, and npm version `0.1.1` do not already exist.
- [x] Confirm the tag workflow will gate publication on green tests and publish its prepared tarball through npm Trusted Publishing.
- [x] Define the post-commit rollout and acceptance checks.

**Verification**: The release can start from a collision-free 0.1.1 commit after hosted CI succeeds.

## Final Verification

- [x] Focused unit regression test passes.
- [x] Packed-install tests pass for OpenCode 1.17.0 and 1.18.1.
- [x] `npm run check` and `npm run test:e2e` pass.

## Release Acceptance

After the implementation commit is pushed, wait for hosted CI before tagging. The `v0.1.1` workflow must create the GitHub Release and checksum, publish npm `latest`, preserve matching integrity between both registries, attach provenance, pass a clean install/import, and resolve the intended permissions on OpenCode 1.18.1.

## Notes

No README change is required because installation and runtime commands are unchanged. The change only restores the question capability that a hypothesis-driven debugging agent needs while retaining OpenCode's guardrails around plan-mode transitions.
