# Specification: GitHub Release and npm publication

**Created**: 2026-07-14
**Status**: Implemented
**Implemented by**: GPT-5 Codex, high reasoning effort
**Source**: User-provided release and deployment plan

## Goal

Publish `@maximtop/opencode-debug-mode` from one tag-triggered GitHub Actions workflow. A valid release tag must first pass the complete project verification, then create a GitHub Release, then publish the exact same packed tarball to the public npm registry.

## Release contract

- `vX.Y.Z` creates a normal GitHub Release and publishes with npm dist-tag `latest`.
- `vX.Y.Z-beta.N` creates a prerelease and publishes with npm dist-tag `beta`.
- `vX.Y.Z-rc.N` creates a prerelease and publishes with npm dist-tag `next`.
- The version in the tag must match `package.json` exactly.
- The tagged commit must be reachable from `origin/master`.
- Tags without `v`, malformed SemVer, unsupported prerelease identifiers, and version mismatches fail before dependency installation or packing.
- The package runtime API does not change.

## Workflow requirements

The workflow `.github/workflows/release.yml` runs automatically for tags matching `v*` and accepts an explicit manual tag input only to recover or retry an existing immutable release. Both paths have this dependency chain:

`prepare -> create-github-release -> publish-npm`

### Prepare

- Use `actions/checkout@v7`, `actions/setup-node@v7`, Node.js 24, and no package-manager cache.
- Validate the release contract and master ancestry.
- Run `npm ci`, `npm run check`, and `npm run test:e2e`.
- Run `npm pack` once, calculate SHA-256, and create a manifest containing npm integrity.
- Upload the tarball, checksum, and manifest with `actions/upload-artifact@v7`.

### GitHub Release

- Download the prepared artifact with `actions/download-artifact@v8`.
- Create the release with generated notes and attach the tarball and checksum.
- Mark beta and rc releases as prereleases.
- Grant only `contents: write`.
- On rerun, accept an existing non-draft release only when its tag, prerelease state, tarball, and checksum match the prepared artifact.
- A manual recovery requires the existing Release and both assets; it never creates or repairs a Release.

### npm publication

- Run only after the GitHub Release job succeeds and use GitHub Environment `npm`.
- Grant only `contents: read` and `id-token: write`.
- Require npm CLI version 11.5.1 or newer.
- Publish the downloaded tarball without rebuilding it, using public access, the mapped dist-tag, and provenance.
- Before publishing, query the registry. If that exact version already exists, treat matching manifest integrity as success and a different integrity as a collision error.
- The bootstrap release may use the environment secret `NPM_TOKEN` with read/write access to the `@maximtop` scope; trusted publishing replaces it after the first successful release.

## Repository and documentation requirements

- Add public repository, homepage, bugs, registry, access, and provenance metadata to `package.json`.
- Document npm installation in `README.md`.
- Document the exact maintainer release procedure and bootstrap-to-OIDC transition in `CONTRIBUTING.md`.
- Prevent ordinary CI from running on tag pushes while preserving branch pushes and pull requests.
- Use release-level concurrency keyed by the tag and do not cancel an in-progress release.
- For a manual recovery, check out the requested tag rather than `master`, verify that `HEAD` equals the tag commit, and reuse the tarball and checksum already verified and attached to the existing GitHub Release. Reconstruct and verify the manifest before upload to the recovery run. If Environment `npm` normally permits only `v*` tags, a narrowly scoped `master` branch policy may exist only for the duration of the manual run and must be removed afterward.

## Failure behavior

- A prepare failure creates neither a Release nor an npm version.
- A GitHub Release failure blocks npm publication.
- A publication failure leaves the GitHub Release intact so the failed job can be retried.
- No release tag is created during implementation; the first `v0.1.0` tag is pushed only after public repository and npm bootstrap authorization are ready.

## Acceptance criteria

- Unit tests cover stable, beta, rc, version mismatch, missing `v`, unsupported suffix, malformed SemVer, and the minimum npm CLI version.
- Static tests cover the tag trigger, job chain, Node.js 24 action versions, permissions, artifact reuse, provenance publish command, retry guards, and CI tag exclusion.
- `npm run check`, `npm run test:e2e`, `npm pack --dry-run`, and `npm publish --dry-run` pass locally.
- For the first real release, GitHub contains generated notes, the tarball, and checksum; the `npm` environment deployment succeeds; npm exposes `@maximtop/opencode-debug-mode@0.1.0`; clean installation works; and provenance verifies.

## Implementation status

The package metadata, helper, tests, documentation, CI tag exclusion, and three-job release workflow are implemented and verified. The GitHub repository is public, `master` remains the default branch, and Environment `npm` normally allows only `v*` tags without approval. A granular token with read/write access to the `@maximtop` scope is stored as the temporary Environment secret `NPM_TOKEN`. Release tags are immutable; a workflow-only failure after Release creation is recovered through the guarded manual path without moving the tag or replacing its assets.
