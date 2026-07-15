# Implementation Plan: Use Questions as Human Evidence Checkpoints

**Created**: 2026-07-15
**Status**: Implemented
**Model**: GPT-5 Codex, high reasoning effort
**Implemented by**: GPT-5 Codex, high reasoning effort
**Type**: Bug Fix
**Input**: Make the OpenCode debug agent behave autonomously like the observed Cursor session: generate competing hypotheses and prepare validated temporary instrumentation before requesting a human reproduction, use structured questions at prepared pre-fix and post-fix human checkpoints, and retain the evidence-before-fix rule.

## Problem

On OpenCode 1.18.1 with GLM 5.2, the debug agent fetched AG-55256, performed static code exploration, promoted one unverified explanation to a leading hypothesis, and used the structured Question tool to ask the developer to choose among speculative fix directions. The Jira issue already supplies a runtime reproduction surface, so no product decision was needed at that point. The expected workflow is to record competing hypotheses, prepare the smallest owned probes, build or validate the instrumented target, ask whether the prepared pre-fix reproduction occurred, and after an evidence-backed fix ask whether the same reproduction is now fixed.

## Research Findings

`assets/debug-agent.md` already requires two to four falsifiable hypotheses, a pre-fix baseline, minimal probes, and an evidence-backed fix. However, it has no explicit autonomy or Question-tool policy. Version 0.1.1 enabled `question` for the custom agent, so models can now treat it as a convenient planning gate even when safe local work remains.

The existing policy test in `tests/unit/agent-policy.test.ts` checks the evidence lifecycle but does not prohibit asking the developer to choose a hypothesis or fix before evidence. The README describes the lifecycle but does not state that safe local investigation and temporary instrumentation proceed without a decision prompt. AG-55256 confirms the relevant task is a Chrome MV3 runtime failure with concrete reproduction steps, not an ambiguous product requirement.

### Root Cause

The prompt distinguishes behavioral fixes from evidence-backed work but does not explicitly classify temporary owned instrumentation as autonomous investigation, constrain the structured Question tool to observations and authorization, or define symmetric pre-fix and post-fix human checkpoints. This ambiguity became user-visible as soon as `question` was allowed.

### Patterns to Follow

- Keep the existing evidence-before-behavioral-fix requirement unchanged.
- Use direct imperative policy language because the contract must hold across OpenCode models.
- Preserve the current human reproduction restriction: ask only for actions inside the target application.
- Questions request observations or required authorization, never speculative causes or implementation choices.
- When a person performs the pre-fix reproduction, require the same human path after the fix before cleanup or success.
- Reuse the exact-string policy assertions in `tests/unit/agent-policy.test.ts`.
- Keep documentation changes inside the existing README Workflow section.

### Edge Cases

- The agent may still ask when required information cannot be discovered from available sources.
- Credentials, devices, external state, external directories, or materially different actions may still require explicit authorization.
- A human reproduction request remains valid only after the baseline transport, probes, and instrumentation check are ready and the wait is checkpointed.
- Temporary probe edits must proceed autonomously, but production behavior must not change before deciding evidence exists.
- If a deterministic test, fixture, or local script can reproduce the failure, the agent must prefer it over asking a person.
- A prepared post-fix question is valid only after the evidence-backed fix and automated checks pass.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `tests/unit/agent-policy.test.ts` | Modify | Lock the autonomy, Question-tool, and prepared-reproduction policy. |
| `tests/unit/documentation.test.ts` | Modify | Require the public workflow documentation to describe autonomous investigation. |
| `assets/debug-agent.md` | Modify | Add the explicit act-before-ask contract without weakening evidence gates. |
| `README.md` | Modify | Document when the debug agent works autonomously and when it asks the developer. |

## Solution

Add a dedicated `Autonomy and questions` section immediately after the scope checkpoint. It will require the agent to continue all safe local investigation, forbid speculative fix-choice questions, and define Question as a deliberate human checkpoint for genuine blockers, required external authorization, or prepared pre-fix/post-fix observations. Strengthen the Baseline, Instrumentation, Human reproduction, Fix, and Verification sections so deterministic reproduction is preferred, owned probes are explicitly non-behavioral investigation, human action waits until tooling is ready, and a user selection cannot replace evidence. Add exact policy tests first, then update the prompt and README.

### Alternatives Considered

Disabling the Question tool again would prevent legitimate structured reproduction requests. Tuning one model or changing temperature would not establish a cross-model behavioral contract. Allowing the user to select a speculative fix would violate the package's evidence-first purpose. The focused prompt contract is therefore the smallest durable fix.

## Tasks

### [x] Task 1: Add failing autonomy policy coverage

**Files:**
- Modify: `tests/unit/agent-policy.test.ts:4-14`
- Modify: `tests/unit/documentation.test.ts:15-23`

- [x] **Step 1: Add the agent-policy regression**

```ts
it("continues safe investigation before using the question tool", async () => {
  const prompt = await readFile("assets/debug-agent.md", "utf8")
  expect(prompt).toContain("Proceed autonomously through all safe local investigation that remains")
  expect(prompt).toContain("Temporary owned instrumentation is investigation, not a behavioral fix")
  expect(prompt).toContain(
    "Never ask the developer to choose a hypothesis, root cause, fix direction, repository, or speculative workaround",
  )
  expect(prompt).toContain('Never ask "How do you want to proceed?" while a safe scoped investigation action remains')
  expect(prompt).toContain(
    "Treat the structured `question` tool as a deliberate human checkpoint, not a progress or planning gate",
  )
  expect(prompt).toContain("Use the structured `question` tool only when")
  expect(prompt).toContain(
    "Do not request human reproduction until the baseline transport, probes, and instrumentation check are ready",
  )
  expect(prompt).toContain("At a prepared pre-fix checkpoint, ask whether the issue reproduced")
  expect(prompt).toContain("At a prepared post-fix checkpoint, ask whether the same reproduction is now fixed")
  expect(prompt).toContain(
    "When pre-fix reproduction required a person, require the corresponding post-fix human verification",
  )
})
```

- [x] **Step 2: Add the documentation regression**

Add this assertion to `documents v1 boundaries and private defaults`:

```ts
expect(readme).toContain("Safe local investigation and temporary instrumentation proceed autonomously")
expect(readme).toContain("whether the issue reproduced")
expect(readme).toContain("whether the same reproduction is now fixed")
```

- [x] **Step 3: Run the focused tests and verify failure**

Run: `npx vitest run tests/unit/agent-policy.test.ts tests/unit/documentation.test.ts`

Expected: FAIL because the current prompt lacks the autonomy/Question contract and the README lacks the public autonomy statement.

**Verification**: The tests fail on the exact missing behavioral contract observed in the screenshots.

Implementation note: both focused tests failed before the prompt and README changes. After the user clarified the lifecycle, the new pre-fix/post-fix checkpoint assertions also failed against the earlier last-resort wording and documentation, then passed after the policy was revised.

### [x] Task 2: Strengthen the debug-agent prompt and checkpoint lifecycle

**Files:**
- Modify: `assets/debug-agent.md:11-39`
- Test: `tests/unit/agent-policy.test.ts`

- [x] **Step 1: Add the autonomy and Question-tool contract**

Insert after `## Scope checkpoint`:

```markdown
## Autonomy and questions

Proceed autonomously through all safe local investigation that remains: obtain available issue context, inspect relevant code, record hypotheses, prefer a deterministic local reproduction, start the baseline, prepare and register minimal probes, and run instrumentation, build, type, or parse checks. Temporary owned instrumentation is investigation, not a behavioral fix. Do not pause merely because multiple causes are plausible.

Never ask the developer to choose a hypothesis, root cause, fix direction, repository, or speculative workaround before deciding evidence exists. Never offer unconfirmed fixes as a Question decision gate. Never ask "How do you want to proceed?" while a safe scoped investigation action remains.

Treat the structured `question` tool as a deliberate human checkpoint, not a progress or planning gate. Use it only for required information unavailable through accessible sources, explicit authorization, or a prepared human reproduction or verification. Every question requests an observation or required authorization, never a speculative cause or implementation choice. If a deterministic local check can answer the checkpoint, run it instead of asking the developer.
```

- [x] **Step 2: Make baseline and instrumentation sequencing explicit**

Add these sentences to the existing Baseline and Instrumentation sections:

```markdown
Prefer a deterministic test, fixture, or local script over human reproduction whenever it can exercise the failure.

Preparing, inserting, registering, and validating an owned temporary probe is safe investigation work; perform it without requesting fix-direction approval.
```

- [x] **Step 3: Tighten human reproduction, fix, and verification gates**

Add these sentences to Human reproduction, Fix, and Verification:

```markdown
Do not request human reproduction until the baseline transport, probes, and instrumentation check are ready. At a prepared pre-fix checkpoint, ask whether the issue reproduced using the exact in-application steps you provide. Summarize the hypotheses the reproduction will distinguish; do not ask the developer which hypothesis or fix to choose.

A developer selection cannot substitute for deciding runtime evidence, a failing test, or a deterministic reproduction.

At a prepared post-fix checkpoint, ask whether the same reproduction is now fixed after the developer repeats the exact in-application steps. Ask only after the evidence-backed fix and automated checks pass. When pre-fix reproduction required a person, require the corresponding post-fix human verification before cleanup or success.
```

- [x] **Step 4: Run the focused policy test**

Run: `npx vitest run tests/unit/agent-policy.test.ts`

Expected: PASS.

**Verification**: The prompt commands safe investigation and instrumentation before a Question while preserving the behavioral-fix evidence gate.

Implementation note: the prompt now exhausts safe local investigation before asking, explicitly treats owned probes as non-behavioral investigation, and uses structured questions only for genuine blockers, required authorization, or prepared pre-fix/post-fix human observations. The focused policy test passes.

### [x] Task 3: Document autonomous investigation

**Files:**
- Modify: `README.md:29-35`
- Test: `tests/unit/documentation.test.ts`

- [x] **Step 1: Add the workflow statement**

Append this paragraph to the README Workflow section:

```markdown
Safe local investigation and temporary instrumentation proceed autonomously. The agent asks the developer only for an undiscoverable blocker, required external authorization, or a prepared human checkpoint: after instrumentation it may ask whether the issue reproduced, and after the evidence-backed fix and automated checks it may ask whether the same reproduction is now fixed. It never asks the developer to select a speculative fix instead of collecting evidence.
```

- [x] **Step 2: Run the focused documentation test**

Run: `npx vitest run tests/unit/documentation.test.ts`

Expected: PASS.

**Verification**: Public documentation matches the prompt's act-before-ask contract.

Implementation note: the README Workflow section now documents autonomous safe investigation, genuine blockers, and the prepared pre-fix/post-fix human checkpoints. The focused documentation test passes.

### [x] Task 4: Verify the complete change

**Files:**
- Modify: `.sdd/.current/quick.md`

- [x] **Step 1: Run project checks**

Run: `npm run check`

Expected: lint, typecheck, unit tests, build, and integration tests pass.

- [x] **Step 2: Run end-to-end tests**

Run: `npm run test:e2e`

Expected: all E2E tests pass.

- [x] **Step 3: Inspect the final diff**

Run: `git diff --check && git diff --stat`

Expected: before the separate release preparation, only the prompt, policy/documentation tests, README, and this quick spec change; package version remains 0.1.1.

**Verification**: All project gates pass before the separate version-bump and release workflow.

Implementation note: `npm run check` passes 117 unit and 23 integration tests, and `npm run test:e2e` passes 14 tests. A clean OpenCode 1.18.1 resolved-agent check loaded the local built plugin with Question enabled and all new autonomy, deliberate-human-checkpoint, observation-only, and evidence-before-fix prompt clauses present. `git diff --check` passes. The implementation gate completed at 0.1.1; the separate release chore then updated package metadata to 0.1.2.

## Final Verification

- [x] Focused policy tests fail before the prompt/README change and pass afterward.
- [x] The prompt forbids speculative fix-choice questions while safe local work remains.
- [x] Deterministic reproduction is preferred and owned temporary instrumentation proceeds autonomously.
- [x] Human reproduction is requested only after baseline transport, probes, validation, and checkpoint readiness.
- [x] Questions ask for observations at prepared pre-fix and post-fix checkpoints, never speculative implementation choices.
- [x] A human pre-fix reproduction requires the corresponding post-fix verification before cleanup or success.
- [x] Evidence is still required before a behavioral fix.
- [x] `npm run check` and `npm run test:e2e` pass.
- [x] The implementation gate completed at version 0.1.1 without external mutation; separate release preparation updated package metadata to 0.1.2.

## Notes

This is a prompt-policy bug, not an AG-55256 product fix. The screenshots provide deterministic evidence of the missing guard, so a runtime log collector is unnecessary. Model behavior cannot be perfectly proven by a static test, but exact imperative policy assertions prevent this regression from silently disappearing and materially reduce cross-model variance.
