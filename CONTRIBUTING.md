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

Releases are manual. Recheck npm name/version availability, inspect the tarball allowlist, and prefer npm trusted publishing with provenance when publication is enabled.
