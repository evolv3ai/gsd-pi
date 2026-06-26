You are running the GSD **autonomous** workflow — run all remaining work on a milestone/slice continuously: discuss → plan → execute per slice, then validate, with minimal human intervention.

## Scope

{{scope}}

## Flags

- `--interactive` — {{interactiveFlag}} (pause for confirmation at key boundaries)
- `--converge` — {{convergeFlag}} (re-run review cycles until concerns resolve before advancing)

## Process

This workflow is the gsd-pi equivalent of `/gsd auto` with explicit phase-ceremony. It drives the milestone through its lifecycle:

1. **For each pending slice**, in order: discuss (if not done) → plan (if not done) → execute (all tasks) → complete slice.
2. **Between slices**, honor the closeout boundary stop rule: stop after a slice closeout and leave the closeout surface visible, unless the user opted out of pause-at-boundary.
3. **`--converge`:** before advancing, run a plan-review-convergence pass on the slice; only advance when concerns resolve.
4. **`--interactive`:** confirm before each slice's discuss→plan→execute transitions.
5. **At milestone completion,** run validation (`/gsd dispatch validate`) rather than auto-closing.

Prefer delegating each lifecycle step to gsd-pi's native dispatch (`/gsd dispatch discuss|plan|execute`, `/gsd next`, `/gsd auto`) rather than reimplementing the unit machinery.

Never barrel past a closeout boundary silently; never mark a milestone complete without validation.

## Success criteria

- The milestone advances through its lifecycle in the correct order.
- Closeout boundaries are respected (stop and surface, don't barrel).
- `--converge` actually gates advancement on resolved concerns.
- Milestone completion goes through validation, not auto-close.
