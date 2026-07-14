# Implementation Plan: Use Node.js 24 GitHub Actions runtimes

**Created**: 2026-07-14
**Status**: Implemented
**Model**: GPT-5 Codex, high reasoning effort
**Implemented by**: GPT-5 Codex, high reasoning effort
**Type**: Configuration
**Input**: Replace GitHub Actions releases that target the deprecated Node.js 20 action runtime with official releases that natively use Node.js 24, while preserving the package compatibility matrix on Node.js 20 and 22, all existing jobs, and no-publish behavior.

## Problem

GitHub Actions reports that `actions/checkout@v4` and `actions/setup-node@v4` target the deprecated Node.js 20 action runtime and are being forced to run on Node.js 24. The workflow must use official action releases whose own runtime is Node.js 24 without changing the Node.js versions used to test this package.

## Research Findings

The workflow is defined entirely in `.github/workflows/ci.yml`. It has `quality`, cross-platform `platform`, and `opencode-compat` jobs. The committed workflow uses `actions/checkout@v4` and `actions/setup-node@v4`; an existing uncommitted edit upgraded them to `@v6` but also removed the Node.js 20/22 platform dimension and changed every project runtime to Node.js 24.

Official `action.yml` metadata for both `actions/checkout@v7` and `actions/setup-node@v7` declares `runs.using: node24`. Their `v7.0.0` releases are the current stable releases on 2026-07-14.

### Root Cause

The warning concerns the JavaScript runtime embedded in the action release, not the `node-version` installed by `setup-node` for project commands. Updating project `node-version` values therefore does not fix the action metadata correctly and would drop required Node.js 20/22 compatibility coverage.

### Patterns to Follow

- Keep action major tags in the existing `uses: owner/action@vN` style.
- Keep the existing three jobs and their commands unchanged.
- Keep `quality` and `opencode-compat` on Node.js 20.
- Keep `platform` on the Cartesian matrix of Ubuntu/macOS/Windows and Node.js 20/22.
- Add a focused unit assertion to prevent action-runtime and project-runtime concerns from being conflated again.

### Edge Cases

- The workflow must not collapse the six platform combinations to three Node.js 24-only jobs.
- The action upgrade must not add a publish step or broaden repository permissions.
- Static verification must reject older action majors even if the installed project runtime is Node.js 24.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `tests/unit/documentation.test.ts` | Modify | Assert Node.js 24-based action majors and the retained Node.js 20/22 compatibility matrix. |
| `.github/workflows/ci.yml` | Modify | Use `checkout@v7` and `setup-node@v7` while preserving all project test runtimes and jobs. |

## Solution

Add a failing workflow policy test, then update every checkout/setup-node reference to `@v7`. Restore the `node: [20, 22]` platform dimension and `${{ matrix.node }}` setup value, and retain Node.js 20 for `quality` and `opencode-compat`.

### Alternatives Considered

`@v6` also declares the Node.js 24 action runtime, but `@v7` is the current stable official major and avoids introducing an already superseded action release. Changing all project jobs to Node.js 24 was rejected because it removes the package's declared minimum-version coverage.

## Tasks

### [x] Task 1: Add workflow policy coverage

**Files:**
- Modify: `tests/unit/documentation.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it("uses Node.js 24 actions without dropping the Node.js 20/22 matrix", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8")
  expect(workflow.match(/actions\/checkout@v7/g)).toHaveLength(3)
  expect(workflow.match(/actions\/setup-node@v7/g)).toHaveLength(3)
  expect(workflow).toContain("node: [20, 22]")
  expect(workflow).toContain(`node-version: \${{ matrix.node }}`)
})
```

- [x] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run tests/unit/documentation.test.ts`
Expected: FAIL because the existing edit uses `@v6` and removed `node: [20, 22]`.

**Verification**: The regression test fails for the exact action-major/matrix mismatch.

Implementation note: the focused test failed on the missing `@v7` references before evaluating the removed matrix, confirming the expected pre-fix state.

### [x] Task 2: Upgrade action runtimes and preserve compatibility coverage

**Files:**
- Modify: `.github/workflows/ci.yml`

- [x] **Step 1: Apply the minimal workflow change**

```yaml
- uses: actions/checkout@v7
- uses: actions/setup-node@v7
  with:
    node-version: 20
    cache: npm

matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  node: [20, 22]
```

Use `node-version: ${{ matrix.node }}` in `platform`; retain `node-version: 20` in `quality` and `opencode-compat`.

- [x] **Step 2: Run the focused test and verify success**

Run: `npx vitest run tests/unit/documentation.test.ts`
Expected: PASS.

- [x] **Step 3: Run project verification**

Run: `npm run check`
Expected: lint, typecheck, 96 unit tests, build, and integration tests pass.

**Verification**: All three action pairs use `@v7`, the six-entry platform matrix remains, and no job or publish behavior changes.

Implementation note: the focused test passes, `npm run check` passes with 96 unit and 23 integration tests, and a lint warning in the new assertion was corrected before final verification.

### [x] Task 3: Verify the hosted workflow

**Files:**
- Modify: `.sdd/.current/quick.md`

- [x] **Step 1: Commit and push the focused change**

Run: `git commit -m "Use Node.js 24 GitHub Actions runtimes" && git push origin master`
Expected: The commit reaches `origin/master` and starts the CI workflow.

- [x] **Step 2: Verify the resulting GitHub Actions run**

Run: `gh run watch "$(gh run list --branch master --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`
Expected: All eight jobs pass and the Node.js 20 action-runtime deprecation annotation is absent.

**Verification**: The hosted run proves both the action-runtime upgrade and the retained package compatibility matrix.

Implementation note: commit `97491b0` was pushed to `master`. GitHub Actions run `29318503313` passed all eight jobs; its only annotations concern the independent `macos-latest` image migration, and the Node.js 20 action-runtime deprecation warning is absent.

## Final Verification

- [x] Run focused policy test: `npx vitest run tests/unit/documentation.test.ts`
- [x] Run full project checks: `npm run check`
- [x] Verify workflow contains three `checkout@v7` and three `setup-node@v7` references.
- [x] Verify hosted CI passes all eight jobs without the Node.js 20 action-runtime warning.

## Notes

The GitHub warning about the future `macos-latest` image migration is independent of this change and remains non-blocking.
