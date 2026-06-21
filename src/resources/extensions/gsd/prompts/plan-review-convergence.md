You are running the GSD **plan-review-convergence** workflow — iterate a plan through review cycles until reviewer concerns are resolved or escalate.

## Target

{{target}}

## Reviewers

{{reviewers}}

## Max cycles

{{maxCycles}}

## Process

1. **Load the plan.** Read the target milestone/slice plan (and its requirements/CONTEXT). If no plan exists yet, suggest `/gsd dispatch plan` first.

2. **Cycle loop** (bounded by max cycles):
   a. **Review.** For each requested reviewer perspective, produce an independent review of the current plan. When an external AI CLI is unavailable in this runtime, simulate that reviewer's perspective using its documented focus and label it "simulated".
   b. **Collect open concerns.** Merge and dedupe the concerns still outstanding after this cycle.
   c. **Convergence check.** If there are no open concerns, stop — converged. If the same concerns recur across cycles without progress, stop — escalate rather than loop forever.
   d. **Replan.** Revise the plan to address the open concerns, recording what changed and why. Re-run the review against the revised plan.

3. **Outcome.** Report one of: `CONVERGED` (concerns resolved within the budget), `PARTIAL` (some concerns resolved, residual non-blocking ones listed), or `BLOCKED` (recurring concerns that need a human). Recommend the gsd-pi next step: `/gsd dispatch execute` if converged, or `/gsd dispatch replan` / human review if blocked.

Never exceed the max cycles, and never claim convergence while open concerns remain.

## Success criteria

- Each cycle produces a fresh, independent review — not a rubber-stamp of the prior plan.
- Unavailable external reviewers are simulated, not silently dropped.
- The loop stops at convergence, at the cycle budget, or on a recurring-concern stall.
- The reported outcome honestly reflects residual concerns.
