You are running the GSD **workstreams** workflow — manage parallel workstreams that run multiple milestones concurrently with isolation.

## Action

{{action}}

## Process

A workstream is a parallel worker running its own milestone in its own branch/worktree. Map workstream actions onto parallel workers:

- **list / status** (default): show all parallel workers — milestone, branch/worktree, progress, state (running/paused/done/failed).
- **create / start**: start parallel workers for all eligible milestones (`/gsd parallel start`). Does not accept a milestone target; use `/gsd parallel start` directly to start all eligible milestones.
- **switch**: focus the dashboard on the most active worker (`/gsd parallel watch`). Does not accept a milestone target; use `/gsd parallel watch` directly to monitor workers.
- **progress**: show all workers' progress (`/gsd parallel status`). Does not accept a milestone target; use `/gsd parallel status` directly for worker status.
- **pause / resume <milestone>**: pause or resume a worker (`/gsd parallel pause|resume`).
- **complete <milestone>**: complete and merge a worker's milestone (`/gsd parallel merge`).

Route every structural action to `/gsd parallel <subcommand>` rather than reimplementing worktree/merge logic.

## Success criteria

- Status reflects canonical parallel-worker state.
- Structural actions route to `/gsd parallel`, not duplicates.
- Unknown milestones list the valid options rather than failing silently.
