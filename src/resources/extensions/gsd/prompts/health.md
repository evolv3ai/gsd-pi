You are running the GSD **health** workflow — validate `.gsd/` directory integrity and report actionable issues, optionally repairing auto-fixable ones.

## Flags

- `--repair` — {{repairFlag}} (when ON, auto-fix detected issues)
- `--context` — {{contextFlag}} (when ON, report context-window utilization instead of directory health)

## Process

### Directory integrity (default; skip if `--context`)

Check the canonical `.gsd/` state for:

- **Missing or malformed artifacts:** ROADMAP, milestone/slice markdown projections, CONTEXT, CAPTURES.
- **DB/disk drift:** rows in the canonical DB that don't match the markdown projections (and vice-versa).
- **Orphaned artifacts:** slices/tasks referenced nowhere, or projections whose DB rows are gone.
- **Incomplete/inconsistent state:** an active milestone that's actually complete, a locked milestone with no lease, stale crash locks.
- **Unmerged completed milestones:** milestones marked complete but never merged/published.

For each issue, classify it: **auto-fixable** (drift repair, projection rebuild) or **needs-human** (data loss, ambiguous state). When `--repair` is ON, apply the auto-fixable fixes (preferring gsd-pi's repair tooling: `/gsd doctor fix`, `/gsd rebuild markdown`). Report exactly what changed.

Prefer delegating the heavy lifting to gsd-pi's existing repair commands rather than hand-editing state.

### Context utilization (only when `--context`)

Report the session's approximate tokens used vs. the active model's context window, and what is consuming it (skills, injections, history). Suggest compaction or pruning if utilization is high.

## Output

Present issues grouped by severity (needs-human first, then auto-fixable). For `--repair`, also list each fix applied with a one-line before/after. If everything is healthy, say so plainly.

## Success criteria

- Every reported issue is concrete and actionable (file/row + what's wrong + how to fix).
- Repairs use gsd-pi repair tooling where it exists.
- No silent destructive changes — auto-fixable means reversible/projection-level only.
- Context mode and directory mode are orthogonal and never mixed.
