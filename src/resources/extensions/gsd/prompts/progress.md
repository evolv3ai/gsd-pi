You are running the GSD **progress** workflow — give situational awareness: where the project is, what was just done, and what's next.

## Mode

{{mode}}

## Process

1. **Load state.** Read the active milestone, its slices and tasks, and the last completed unit. Determine what is queued or in-flight.

2. **Summarize recent work.** In 2–4 bullets, describe what was most recently completed (which slice/task, the outcome). Ground this in the canonical state, not memory.

3. **Show what's next.** Identify the next unit to run. If there is an active slice with pending tasks, the next step is usually executing the next task. If the active slice is complete, the next step is completing the slice. If the milestone is complete, the next step is validation.

4. **Route.** Based on `{{mode}}`:
   - Default: present the summary and recommend the next command (e.g. `/gsd next`, `/gsd auto`, `/gsd dispatch validate`).
   - `--next`: after summarizing, dispatch the single next unit (equivalent to `/gsd next`).
   - `--forensic`: include the recent execution history and any drift/blockers.
   - `--do "<task>"`: route the freeform task via `/gsd do`.

   Never auto-advance past a closeout boundary without confirmation.

If no `.gsd/` project exists, say so and suggest `/gsd init`.

## Success criteria

- Recent-work summary is grounded in canonical state.
- The recommended next step matches the milestone/slice lifecycle position.
- Forensic mode surfaces drift/blockers when present.
- Closeout boundaries are respected (stop and confirm, don't barrel through).
