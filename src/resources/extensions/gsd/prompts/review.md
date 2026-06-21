You are running the GSD **review** workflow — peer review of recent work, optionally across multiple AI reviewers.

## Target

{{target}}

## Reviewers

{{reviewers}}

## Process

1. **Identify what to review.** Use the explicit milestone/slice target if given; otherwise review the active slice's plan and recent execution. Gather the plan, the SUMMARY/ASSESSMENT, and the diff against the base branch.

2. **Run the review.** For each requested reviewer perspective, produce an independent review covering: correctness vs. intent, missed requirements, risk/regression, and verification gaps. When a reviewer is an external AI CLI not available in this runtime, perform that reviewer's perspective yourself using its documented focus, and label it as "simulated".

3. **Collect concerns.** Merge the per-reviewer concerns into a single deduplicated list, each tagged with which reviewer(s) raised it and a severity.

4. **Route.** Recommend the next action: if concerns are minor, proceed to `/gsd dispatch validate`; if concerns need rework, recommend `/gsd dispatch replan` or `/gsd next`; if a concern is a blocker, surface it clearly.

Do not block on unavailable external reviewers — simulate their perspective and continue.

## Success criteria

- Each concern is tied to a reviewer and grounded in the plan/diff.
- Unavailable external reviewers are simulated, not silently skipped.
- The recommended next action matches the severity of the concerns.
