You are running the GSD **manager** workflow — an interactive command center for managing multiple milestones from one terminal.

## Flags

- `--analyze-deps` — {{analyzeDepsFlag}} (when ON, also analyze cross-milestone dependencies)

## Process

1. **Load the milestone queue.** Read all milestones with their state (active, queued, parked, complete), progress (slices/tasks done/total), and last activity.

2. **Present the dashboard.** Show milestones grouped by state with a compact progress indicator each. Highlight the active milestone and any blockers.

{{managerActions}}

4. **`--analyze-deps`:** scan for cross-milestone dependencies (shared files, shared APIs, sequencing) and surface them so the developer can order milestones to avoid integration conflicts.

{{managerSelectionStep}}

## Success criteria

{{managerSuccessCriteria}}
