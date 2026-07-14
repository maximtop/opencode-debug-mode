# Investigation lifecycle

The durable phases are intake, hypotheses, baseline, instrumenting, waiting for reproduction, analyzing, fixing, verifying, cleaning, and a terminal completed/abandoned/escalated outcome.

Every meaningful transition uses revision compare-and-swap. A resumed turn and compaction hook require state reading before another action. Missing, malformed, oversized, stale, or unsupported state returns an explicit recovery result; the package never invents lost conclusions.

A process lease and an explicit waiting-for-reproduction lease suppress idle expiry. Unauthenticated collector traffic does not update activity. The next active tool action ends an obsolete wait. Idle unleased sessions are cleaned after 30 minutes.

Normal completion and all terminal paths use the same idempotent cleanup. Session deletion, plugin disposal, collector failure, timeout, cancellation, and verified expired startup recovery also converge on teardown. Recovery scans only direct package-owned `session-*` children and ignores active, unrelated, invalid, or symlinked entries.

With default deletion, the lifecycle ends with no session directory. With explicit retention, sanitized public files are staged before ephemeral deletion and finalized only after a secret scan.
