You are running the GSD **audit-fix** workflow — autonomous audit-to-fix pipeline: find issues, classify them, fix the auto-fixable ones, test after each fix, and commit atomically.

## Source

{{source}}

## Severity filter

{{severity}}

## Max fixes

{{maxFixes}}

## Dry run

{{dryRun}}

## Process

1. **Run the audit.** Use the named source audit (default: the most recent audit-uat / scan findings). If no audit exists, run a fresh `/gsd scan --focus concerns` first and use those findings.

2. **Parse and classify findings.** For each finding, decide: `auto-fixable` (deterministic, localized, no public-behavior change) or `manual-only` (ambiguous, risky, or behavior-changing). Apply the severity filter and the `--max` cap.

3. **Fix loop** (skip entirely if `--dry-run`). For each auto-fixable finding, in priority order:
   - Apply the fix.
   - Run the project's tests.
   - If tests pass, stage the change and record the finding id.
   - If tests fail, revert that fix, mark it manual-only, and continue.
   Commit atomically, referencing the finding ids in the commit message for traceability.

4. **Report.** List: fixed (with finding ids + commits), deferred to manual (with reasons), and any that were attempted but reverted due to test failure.

## Success criteria

- Every fix is tested before it's kept; failing fixes are reverted, not left half-applied.
- Commits are atomic and reference finding ids.
- `--dry-run` shows what would be fixed without changing anything.
- Manual-only findings are reported, not silently ignored.
