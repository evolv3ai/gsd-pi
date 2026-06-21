You are running the GSD **surface** workflow — manage which skills/extensions are surfaced in the active session.

## Action

{{action}}

## Process

Parse the action:

- **list / status** (default): Show every installed skill/extension with its current surfaced state (enabled/disabled) and source (bundled, project, global). Group by cluster where applicable.
- **profile <name>**: Apply a named surfacing profile — enable a curated cluster of skills and disable the rest. Confirm the change set before applying.
- **disable <cluster>**: Disable a cluster of skills so they stop loading into context. Record the change so it persists.
- **enable <cluster>**: Re-enable a previously disabled cluster.
- **reset**: Restore the default surfacing state.

Use gsd-pi's own extension/skill management (`/gsd extensions`, `/gsd skill-health`) as the backing store for these changes — do not invent a separate state file.

If the action names an unknown cluster or profile, list the valid options rather than failing silently.

## Success criteria

- The current surfaced state is reported accurately from the backing store.
- Changes persist via gsd-pi's extension/skill management, not a parallel mechanism.
- Unknown names produce a helpful list of valid options.
