# Implementation Plan: GitHub Release and npm publication

**Created**: 2026-07-14
**Status**: Implemented
**Model**: GPT-5 Codex, high reasoning effort
**Implemented by**: GPT-5 Codex, high reasoning effort

## Tasks

### [x] Task 1: Define and test the release contract

**Files:**
- Create: `scripts/release-metadata.ts`
- Create: `tests/unit/release-metadata.test.ts`
- Modify: `tsconfig.json`

- [x] Add failing tests for stable, beta, rc, malformed or unsupported tags, exact version matching, and npm CLI minimum version.
- [x] Implement a dependency-free release metadata helper and Node.js 24 CLI that writes GitHub Actions outputs.
- [x] Run the focused unit test and typecheck.

Implementation note: the focused test first failed because the helper did not exist, then all 16 release metadata tests and the project typecheck passed.

### [x] Task 2: Specify release metadata and workflow policy

**Files:**
- Modify: `tests/unit/package-metadata.test.ts`
- Modify: `tests/unit/documentation.test.ts`
- Create: `tests/unit/release-workflow.test.ts`

- [x] Add failing assertions for public npm metadata, release documentation, release workflow structure, minimal permissions, action versions, artifact reuse, idempotency guards, and ordinary CI tag exclusion.
- [x] Run the focused tests and confirm they fail before implementation.

Implementation note: the focused tests failed on the intentionally missing package metadata, release documentation, tag filter, and release workflow.

### [x] Task 3: Implement package metadata and documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [x] Add repository, homepage, bugs, and public/provenance publish configuration.
- [x] Document npm installation, the exact tag procedure, supported prerelease mappings, failure behavior, and bootstrap-to-trusted-publishing transition.
- [x] Run focused metadata and documentation tests.

Implementation note: the package was later moved into the `@maximtop` npm scope so its bootstrap token can grant precise scope-level access. The lockfile root metadata, installation documentation, and packed-install E2E path were updated with the package name. The focused metadata and release documentation tests pass.

### [x] Task 4: Implement the release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`

- [x] Implement `prepare` with tag/master validation, full verification, one pack operation, checksum/manifest generation, and artifact upload.
- [x] Implement idempotent `create-github-release` with generated notes and prepared assets.
- [x] Implement `publish-npm` with Environment `npm`, npm CLI validation, registry integrity comparison, exact tarball publication, bootstrap token, and provenance.
- [x] Restrict ordinary CI branch pushes so tag pushes do not duplicate jobs.
- [x] Run focused workflow policy tests.

Implementation note: all 30 focused release tests pass, both workflow YAML files parse, every generated shell block passes `bash -n`, and the exact pack step produced a tarball whose SHA-1, SHA-256, SHA-512 integrity, manifest, and checksum all verified locally.

### [x] Task 5: Verify and roll out prerequisites

**Files:**
- Modify: `.sdd/.current/spec.md`
- Modify: `.sdd/.current/plan.md`

- [x] Run `npm run check` and `npm run test:e2e`.
- [x] Run `npm pack --dry-run` and `npm publish --dry-run`.
- [x] Make the GitHub repository public and configure Environment `npm` for protected `v*` tags.
- [x] Verify npm bootstrap authorization without creating the release tag.
- [x] Mark implemented local work complete and report any remaining external prerequisite.

Implementation note: local verification passed with 116 unit, 23 integration, and 14 E2E tests plus successful build, pack dry-run, and publish dry-run. GitHub reports a public repository with default branch `master`; Environment `npm` has no approval and normally permits only tag `v*`. The locally stored granular token authenticates as `maximtop`, grants the required `@maximtop` scope access, and is provisioned as the Environment secret `NPM_TOKEN`. Tag `v0.1.0` was created only after these prerequisites and hosted CI passed.

### [x] Task 6: Add immutable-tag release recovery

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `tests/unit/release-workflow.test.ts`
- Modify: `tests/unit/documentation.test.ts`
- Modify: `CONTRIBUTING.md`

- [x] Publish local tarballs through an explicit `./release/...` path so npm cannot parse the path as GitHub shorthand.
- [x] Add an explicit manual tag input that checks out and verifies the immutable tag commit.
- [x] Reuse and validate the existing GitHub Release tarball and checksum rather than rebuilding a potentially different archive.
- [x] Require an existing complete Release for recovery and preserve registry collision checks.
- [x] Document the temporary `master` Environment policy and exact recovery command.
- [x] Add regression coverage and execute the exact recovery and tarball publish shell paths locally.

Implementation note: the first `v0.1.0` run completed preparation and GitHub Release creation, then npm interpreted `release/<tarball>.tgz` as GitHub shorthand. The targeted path fix and guarded manual recovery preserve the original tag and Release assets.

## Constraints

- Preserve `master` as the main branch.
- Do not add GitHub Packages, Pages, a second release workflow, or a changelog.
- Do not rebuild the package after `prepare`.
- Never move or reuse a release tag; recover workflow-only failures through the explicit manual path.
