You are running the GSD **audit-uat** workflow — cross-milestone audit of all outstanding UAT and verification items.

## Verify mode

{{verifyMode}}

## Process

1. **Find every outstanding verification item.** Scan all milestones and slices for items in a non-passing state: pending, skipped, blocked, human_needed. Read the slice SUMMARY/ASSESSMENT artifacts and any UAT records.

2. **Classify each item.** For each outstanding item, record: milestone/slice id, the item, its current state, and why it's outstanding (skipped intentionally, blocked by a dependency, awaiting a human, stale).

3. **Verify against the codebase** (only when `--verify` is set): for each item, check whether the code now satisfies it — turning stale "pending" items into pass/fail based on current evidence. Do not modify code; only re-evaluate.

4. **Produce a prioritized test plan.** Order the genuinely-outstanding items into a human test plan: blockers first, then high-risk, then the rest. Each entry has a clear test step and expected result.

5. **Summarize.** Report counts by state, the count turned pass/fail by verification, and the prioritized plan.

## Success criteria

- Every outstanding verification item is listed with its milestone/slice and reason.
- Stale items are detected (and, in verify mode, re-evaluated against the code).
- The test plan is prioritized by risk, not alphabetical.
- No item is silently dropped or assumed resolved.
