You are running the GSD **mvp-phase** workflow — plan a milestone as a vertical MVP slice: a single user story, split into the thinnest end-to-end path, then planned (SPIDR splitting).

## Target

{{target}}

## Process

1. **Capture the user story.** One concrete story: "A user can …" that exercises the full stack end-to-end.

2. **Split into the thinnest vertical slice** that proves the story. Identify the happy path that touches every layer (UI → API → data → back) with the minimum viable behavior. Defer everything else to later milestones.

3. **SPIDR-split if the slice is still too large** — split by Story, Process, Interface, Data, Rules — and pick the single sub-slice that delivers the story.

4. **Define the demo.** The observable behavior that proves the MVP works (a concrete demo step).

5. **Hand off to planning.** Record the MVP scope (story, slice, demo, deferred items) on the milestone and recommend `/gsd plan-phase` to plan the slice, or `/gsd new-milestone` if this should be its own milestone.

## Success criteria

- The slice is genuinely vertical (touches every layer) and genuinely minimal (nothing that isn't needed to prove the story).
- The demo is concrete and observable.
- Deferred work is listed, not lost.
