<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR (accepted) for the behavioral contract distinguishing `workspace.mode: parent` from `project` — the foundational slice of the multi-repository parent-workspace epic (#818). -->

# ADR-043: Parent-Workspace Mode Is Behavioral

**Status:** Accepted
**Date:** 2026-07-01
**Author:** GSD architecture review
**Related:** [open-gsd/gsd-pi#818](https://github.com/open-gsd/gsd-pi/issues/818) (parent-workspace epic), ADR-002 (external-state directory), `CONTEXT.md` workspace repository registry

## Context

### The seam that was inert

`workspace.mode: "parent"` and `workspace.repositories` were added as a schema
seam (preferences schema, validation, `RepositoryRegistry`, `target_repositories`
in the DB and `plan-slice`, per-repo verification, per-repo commit) — but the
`mode` value gated **no runtime behavior**. The registry behaved identically in
`project` and `parent` modes. Two concrete defects flowed from that:

1. **Silent root-attribution.** `defaultRepositoryTargets()` always returned
   `["project"]` because the implicit `project` repository is always present
   (unconditionally inserted into the registry). So every slice/task with
   omitted `targetRepositories` was attributed to the root repo even when the
   user had declared child repositories and set `mode: parent`. The result was
   silently wrong attribution — the worst class of bug.
2. **No contract.** `mode: parent` with zero declared child repositories was
   accepted silently, producing a registry indistinguishable from `project`
   mode. There was no documented or enforced difference between the two modes.

### Why the contract was enforced at validation, not the registry factory

`createRepositoryRegistryFromPreferences` is called from three hot-path sites
that are **not** wrapped in try/catch: `git-service.ts` (`collectRepositoryDirtyStatus`,
`runPerRepositoryCommitAction`) and `auto-verification.ts` (`resolveVerificationTargets`).
Throwing there on a misconfiguration would propagate as an uncaught exception
into the auto loop. The single wrapped caller is the cold `plan-slice` path.

Preference validation already sanitizes safely: validation errors become
diagnostics surfaced to the user, and the partially-valid preferences still
flow through to runtime. So enforcing "parent requires child repos" at the
validation layer degrades gracefully (the user sees the error) without ever
throwing mid-turn.

## Decision

`workspace.mode: "parent"` now has a defined, enforced behavioral contract that
differs from `project` mode:

1. **Validation gate.** `mode: "parent"` with no declared child repositories is
   rejected at validation time with the error:
   `workspace.mode "parent" requires at least one repository under workspace.repositories`.
   This is parse-time sanitization — the error surfaces as a preference
   diagnostic; the runtime never sees a parent mode that is indistinguishable
   from project mode.

2. **Mode-aware defaults.** `defaultRepositoryTargets(registry)` now branches on
   `registry.mode`:
   - `parent` mode → the declared child repository ids (declaration order),
     excluding the implicit `project` repo. If there are no child repos, `[]`
     (so planners reject omitted-target validation rather than silently picking
     the root).
   - `project` mode → `["project"]` exactly as before.

### What this slice does NOT wire (tracked in #818)

This ADR records only the **mode contract** — the foundational slice the other
gaps build on. Explicitly out of scope, as separate slices on the same epic:

- **Planner prompts** do not yet instruct the agent to populate
  `target_repositories`; defaults now flow correctly, but the agent is not yet
  prompted to choose.
- **Codebase map** (`CODEBASE.md`) still runs a single `git ls-files` at the
  project root; child-repo files do not yet enter planning context.
- **Git isolation** (worktree/branch) remains root-only.
- **Layout** still requires child repos nested inside the project root.
- **Discovery/UX**: no wizard or `/gsd` affordance offers parent mode.

## Consequences

- **Backward compatible.** `mode: project` (the default) and the implicit
  `project` repository are unchanged. Single-repo projects — including all
  hot-path callers when preferences are `undefined` or `project`-mode — see no
  behavior change.
- **Behavior change for `parent` users.** With declared child repos, omitted
  `targetRepositories` now default to those repos instead of the root. Without
  declared repos, the user now gets a clear validation error instead of silent
  project-mode-equivalent behavior. This is the intended, fail-loud fix.
- **Safe degradation.** Even if an invalid `parent` configuration reaches
  runtime (e.g. validation diagnostics ignored), `defaultRepositoryTargets`
  returns `[]` rather than throwing — no hot path crashes.
