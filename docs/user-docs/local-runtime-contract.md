# Project-local runtime contract

GSD discovers an optional project-local contract that tells agents how to start, inspect, seed, and stop a business project's local runtime. This avoids guessed ports, working directories, environment files, and direct package or container commands in repositories with custom startup choreography.

## Default convention

Create `script/local-runtime/` at the project root. GSD recognizes these files:

- `AGENT.md` — rules agents must follow before changing runtime state.
- `README.md` — human-readable startup, health, seed, and teardown instructions.
- `runtime.mjs`, `runtime.js`, `runtime.ts`, or `runtime.sh` — the canonical entry point, discovered in that priority order.

When any recognized file exists, GSD safely opens and injects bounded snapshots of `AGENT.md` and `README.md`, plus validated entry-point metadata, into agent and subagent system context. GSD does not automatically execute the entry point or infer its actions.

Default discovery selects the first entry point that exists. Snapshot validation rechecks the absence of every higher-priority candidate; once an entry is selected, lower-priority files do not affect that snapshot.

```text
script/
└── local-runtime/
    ├── AGENT.md
    ├── README.md
    └── runtime.mjs
```

Document the actions supported by the entry point in `README.md`, for example:

```text
node script/local-runtime/runtime.mjs start
node script/local-runtime/runtime.mjs status
node script/local-runtime/runtime.mjs seed
node script/local-runtime/runtime.mjs stop
```

## Custom location

Set `runtime.contract` in project-local `.gsd/PREFERENCES.md` to nominate a different directory or entry point:

```yaml
---
runtime:
  contract:
    path: ops/dev
    entry: run.mjs
---
```

Global preferences do not activate or override a runtime contract; each project must opt in locally when it does not use the default path.

Both values must be relative paths that remain inside the project. Recognized contract members must be real regular files; symlinks are rejected even when their targets remain inside the contract directory.

When `entry` is set, that exact file must exist and validate inside the contract directory. An invalid project override does not fall back to the default convention.

## Project, worktree, and subagent scope

Discovery starts at the repository root even when the active working directory is nested. In a GSD worktree, the active worktree root is authoritative, so agents read the contract version checked out in that worktree.

Subagents launched from a parent project into a nested child repository inherit the parent's runtime contract while keeping other project context local to the child. Explicitly isolated subagents likewise inherit the contract from the checkout that owns the task, rather than treating the temporary isolated checkout as a new runtime authority.

In a parent workspace, place the shared contract at the parent project root. Child-repository startup can then be coordinated through one documented entry point.

## Validation and failure behavior

If a configured or discovered contract cannot be validated or safely snapshotted, GSD injects a blocking diagnostic instead of contract content. A malformed project preference that attempts to set `runtime.contract` also fails closed and does not expose or fall back from the invalid value.

Each authoritative document is limited to 8,000 bytes, and the complete rendered contract block is limited to 20,000 bytes. Authoritative instructions are never injected partially. Entry points are validated by stable identity and metadata without reading their contents or applying the document limit.

Agents must not start, restart, seed, stop, reset, or tear down the runtime until the contract is repaired. A project with no configured contract and no recognized files remains behavior-neutral.
