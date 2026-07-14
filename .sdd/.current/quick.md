# Implementation Plan: Reduce CI to Node.js 24

**Created**: 2026-07-14
**Status**: Implemented
**Model**: GPT-5 Codex, high reasoning effort
**Implemented by**: GPT-5 Codex, high reasoning effort
**Type**: Configuration
**Input**: Remove the Node.js 20/22 CI dimension to avoid unnecessary resource use. Keep one platform job per Ubuntu, macOS, and Windows, run all project jobs on Node.js 24, and retain the Node.js 24-based GitHub Actions releases.

## Problem

The workflow currently runs the platform suite six times: three operating systems multiplied by Node.js 20 and 22. The user explicitly prefers lower CI resource usage over continuous verification of both older Node.js versions.

## Research Findings

`.github/workflows/ci.yml` uses `actions/checkout@v7` and `actions/setup-node@v7`; their official action metadata declares the Node.js 24 action runtime. The `quality` and `opencode-compat` jobs currently install Node.js 20, while the `platform` job combines three operating systems with Node.js 20/22. Removing only the `node` dimension reduces the workflow from eight jobs to five without removing an operating system, quality checks, or OpenCode compatibility checks.

### Root Cause

The platform matrix treats Node.js version as a second dimension even though the user no longer requires that compatibility coverage. This doubles the three expensive platform jobs, including real packed OpenCode installations on Windows.

### Patterns to Follow

- Keep `actions/checkout@v7` and `actions/setup-node@v7` in all three job definitions.
- Keep the `quality`, `platform`, and `opencode-compat` jobs and their commands unchanged.
- Keep the OS matrix `[ubuntu-latest, macos-latest, windows-latest]`.
- Use `node-version: 24` in every setup-node step.
- Do not add publish behavior or broaden permissions.

### Edge Cases

- The workflow must still test all three operating systems.
- The package's `engines.node >=20` declaration remains unchanged; this change intentionally stops continuously verifying the lower bound.
- The regression test must distinguish the three workflow definitions from the five expanded hosted jobs.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `tests/unit/documentation.test.ts` | Modify | Assert three Node.js 24 setup definitions and the absence of a Node.js version matrix. |
| `.github/workflows/ci.yml` | Modify | Remove `matrix.node` and run every job on Node.js 24. |

## Solution

First update the workflow policy test so the current Node.js 20/22 matrix fails. Then remove `node: [20, 22]`, replace `${{ matrix.node }}` with `24`, and change the two fixed Node.js 20 setup values to `24`. Verify locally and in hosted CI, where five jobs must pass without the deprecated Node.js 20 action-runtime annotation.

### Alternatives Considered

Keeping a single Node.js 20 lower-bound job would preserve some compatibility evidence but would still spend resources the user explicitly asked to remove. Testing only Ubuntu was rejected because the user asked to remove the Node.js matrix, not the operating-system coverage.

## Tasks

### [x] Task 1: Update workflow resource policy coverage

**Files:**
- Modify: `tests/unit/documentation.test.ts`

- [x] **Step 1: Replace the old matrix-preservation assertions**

```ts
it("uses Node.js 24 actions without a redundant Node.js version matrix", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8")
  expect(workflow.match(/actions\/checkout@v7/g)).toHaveLength(3)
  expect(workflow.match(/actions\/setup-node@v7/g)).toHaveLength(3)
  expect(workflow.match(/node-version: 24/g)).toHaveLength(3)
  expect(workflow).not.toContain("node: [20, 22]")
  expect(workflow).not.toContain("matrix.node")
})
```

- [x] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run tests/unit/documentation.test.ts`
Expected: FAIL because the current workflow has no `node-version: 24` values and still contains the Node.js 20/22 dimension.

**Verification**: The policy test fails against the resource-heavy workflow.

Implementation note: the focused test failed on the missing three `node-version: 24` values, confirming the expected pre-change state.

### [x] Task 2: Collapse the Node.js matrix

**Files:**
- Modify: `.github/workflows/ci.yml`

- [x] **Step 1: Apply the minimal workflow change**

```yaml
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]

- uses: actions/setup-node@v7
  with:
    node-version: 24
    cache: npm
```

Use `node-version: 24` in `quality`, `platform`, and `opencode-compat`; remove only the `node` matrix dimension.

- [x] **Step 2: Run the focused test and verify success**

Run: `npx vitest run tests/unit/documentation.test.ts`
Expected: PASS.

- [x] **Step 3: Run project verification**

Run: `npm run check`
Expected: lint, typecheck, 96 unit tests, build, and 23 integration tests pass.

**Verification**: The workflow defines three action pairs, three Node.js 24 setup values, three operating-system variants, and no Node.js version dimension.

Implementation note: the focused test passes and `npm run check` passes with clean lint/typecheck, 96 unit tests, build, and 23 integration tests.

### [x] Task 3: Verify reduced hosted CI

**Files:**
- Modify: `.sdd/.current/quick.md`

- [x] **Step 1: Commit and push the focused change**

Run: `git commit -m "Reduce CI to Node.js 24" && git push origin master`
Expected: The commit reaches `origin/master` and starts the CI workflow.

- [x] **Step 2: Verify the resulting GitHub Actions run**

Run: `gh run watch "$(gh run list --branch master --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`
Expected: Five jobs pass: `quality`, `opencode-compat`, and one `platform` job for each operating system. The Node.js 20 action-runtime deprecation annotation is absent.

**Verification**: Hosted CI confirms the resource reduction and retained OS coverage.

Implementation note: commit `48b6cde` was pushed to `master`. GitHub Actions run `29322133793` passed exactly five jobs: `quality`, `opencode-compat`, and one `platform` job for Ubuntu, macOS, and Windows. The deprecated Node.js 20 action-runtime annotation is absent.

## Final Verification

- [x] Run focused policy test: `npx vitest run tests/unit/documentation.test.ts`
- [x] Run full project checks: `npm run check`
- [x] Verify three `checkout@v7`, three `setup-node@v7`, and three `node-version: 24` references.
- [x] Verify hosted CI passes exactly five jobs without the Node.js 20 action-runtime warning.

## Notes

This user-approved tradeoff means the package still declares Node.js 20 support but CI no longer continuously proves it. The independent `macos-latest` image migration annotation may remain.
