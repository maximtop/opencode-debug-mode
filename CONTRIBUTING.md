# Contributing

Use Node.js 20 or newer and npm. Install reproducibly with `npm ci`.

Before submitting a change, run:

```sh
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run coverage
npm run build
npm pack --dry-run
```

Behavior changes should begin with a failing focused test. Preserve the stable public tool names, machine-readable envelopes, strict schemas, bounded data flow, trusted-session isolation, and exact ownership cleanup. Do not add a new evidence transport or probe language without cross-platform syntax, end-to-end capture, verification, cleanup, security, and stress coverage.

Agent-policy changes must also pass the real OpenCode behavioral acceptance harness against a fresh server and disposable project. The release gate is two consecutive unchanged `tokenguard/deepseek-v4-flash` variant `high` runs of the default `synthetic-cli` profile. Each run must autonomously reproduce the deterministic bug with runtime evidence, apply only the expected one-line fix, verify the same test, clean its instrumentation, and finish without a Question. Run `--profile ag-55256` afterward as the larger Browser Extension smoke test; never point either profile at a developer worktree.

## Releases

Pushing a supported version tag runs one automated pipeline: prepare and test the package, create the GitHub Release, then publish the exact prepared tarball to npm with provenance. The tag and `package.json` version must match exactly:

- `vX.Y.Z` publishes with npm dist-tag `latest`.
- `vX.Y.Z-beta.N` creates a prerelease and publishes with npm dist-tag `beta`.
- `vX.Y.Z-rc.N` creates a prerelease and publishes with npm dist-tag `next`.

Only tag commits that belong to `master`. For a normal patch release:

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "Bump version to X.Y.Z"
git push origin master
# Wait for the CI workflow on master to pass.
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Use the same sequence with an exact `X.Y.Z-beta.N` or `X.Y.Z-rc.N` version for a prerelease. Do not move or reuse a published tag or version.

The release workflow is safe to rerun. It accepts an existing GitHub Release only when the tag, prerelease state, tarball, and checksum match. If the npm version already exists, its registry integrity must match the prepared manifest; any mismatch is reported as a collision. A failed npm publish leaves the GitHub Release in place, so normally rerun only the failed job. If the workflow itself must be fixed first, commit the fix to `master`, temporarily allow branch `master` in the GitHub Environment `npm`, manually run the same Release workflow with the existing version tag, and let it check out that immutable tag and verify the existing assets before publishing. Remove the temporary branch policy immediately after the run. Never move or replace the tag.

```sh
gh workflow run release.yml --ref master -f tag=vX.Y.Z
```

The manual recovery reuses the tarball and checksum already attached to the GitHub Release instead of rebuilding them. Keep the temporary `master` policy until the complete run succeeds, including `publish-npm`; then remove it. Provenance for this exceptional recovery points to the recovery workflow commit on `master`, while the verified manifest, checksum, and package contents remain bound to the immutable release tag.

### npm publishing authentication

The package uses an npm Trusted Publisher bound to user `maximtop`, repository `opencode-debug-mode`, workflow `release.yml`, Environment `npm`, and permission `npm publish`. The Environment has no manual approval and normally permits only protected tag pattern `v*`. Do not add `NODE_AUTH_TOKEN` or `NPM_TOKEN`: releases authenticate only through GitHub OIDC and receive provenance automatically.

The bootstrap `v0.1.0` publication used a short-lived granular token because the npm package did not exist yet. That token and its GitHub secret were removed after Trusted Publishing was configured, and the package now disallows token-based publication.
