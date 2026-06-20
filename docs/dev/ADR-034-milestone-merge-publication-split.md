<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR for finishing Worktree Lifecycle ownership of the merge verb and extracting the Publication module (push/PR). -->

# ADR-034: Finish the Merge Verb; Split Publication Out

**Status:** Accepted
**Date:** 2026-06-10
**Author:** GSD architecture review
**Related:** ADR-016 (worktree lifecycle and projection), ADR-025 (Closeout Consistency Gate), ADR-031 (worktree placement), ADR-032 (Unit Closeout module)

## Context

### The recorded owner and the actual owner disagree

CONTEXT.md names the Worktree Lifecycle module "sole owner of worktree
create/enter/teardown/merge verbs." `exitMilestone` shipped
(`worktree-lifecycle.ts:1459`) and callers route through it — but the verb's
body still delegates to `mergeMilestoneToMain` in `auto-worktree.ts:1485`:
an 875-line function that owns, in one implementation:

- dirty-state commit (`auto-worktree.ts:1439`)
- the squash merge itself, conflict handling
- push when `prefs.auto_push` (`auto-worktree.ts:2261`)
- PR creation when `prefs.auto_pr` (`auto-worktree.ts:2279`, shells `gh`)

Above it, `auto/phases.ts` wraps the call with stash-restore choreography
(`_runMilestoneMergeWithStashRestore`, phases.ts:606) invoked from **four**
sites (1197, 1302, 1405, 3189). The stash discipline — part of the merge
verb's own contract — lives in the caller.

### Two distinct concerns fused

Merging a milestone branch into the integration branch is a *worktree
lifecycle* concern: it needs the worktree, the branch, the lease, the stash
discipline. Pushing and opening a PR are *publication* concerns: they need a
remote, credentials, and preferences — and nothing from the worktree beyond
the resulting commit. Fusing them means publication cannot be tested without
a full merge fixture, and no other path (notably the interactive adapter of
ADR-032) can publish without dragging the merge machinery along.

## Decision

### 1. The merge verb's full contract moves inside Worktree Lifecycle

`exitMilestone({ merge: true })` absorbs the stash-restore choreography that
`phases.ts` currently wraps around it. The four call sites collapse to plain
`exitMilestone` calls; `_runMilestoneMergeWithStashRestore` is deleted. The
merge implementation (dirty-commit, squash, conflict classification) moves
out of `auto-worktree.ts` into the Worktree Lifecycle module, making the
CONTEXT.md ownership statement true.

Conflict outcomes remain typed results handed to Recovery Classification —
the verb reports; it does not decide retry/stop.

### 2. Publication becomes its own module

```ts
// publication.ts
publish(request: PublicationRequest): Promise<PublicationResult>

interface PublicationRequest {
  basePath: string;
  branch: string;           // what to push
  milestoneId: string;
  prefs: { autoPush: boolean; autoPr: boolean };
}
// PublicationResult: { pushed, prCreated, prUrl?, error? }
```

`exitMilestone` stops knowing about remotes. The Unit Closeout module
(ADR-032) calls `publish` after a successful milestone merge — on either
adapter. Publication failures are non-fatal to the merge: the milestone is
merged locally; the result records what publication achieved.

### 3. Substitutability

Two adapters justify the seam: the real `gh`/git-push implementation in
production, and an in-memory recorder in tests. Merge tests stop needing
network/credential stubs; publication tests stop needing merge fixtures.

## Consequences

- **Locality:** merge bugs (stash, dirty-tree, conflict ordering — the #4704
  class) concentrate in the Worktree Lifecycle module; publication bugs
  (auth, remote, `gh` availability) concentrate in Publication.
- **4 call sites → 1 verb.** `phases.ts` sheds ~100 lines of choreography it
  never owned.
- **`mergeMilestoneToMain` shrinks** from 875 lines to a merge core; the
  push/PR tail (~100 lines) moves behind `publish`.
- **Interactive parity:** ADR-032's interactive adapter publishes through the
  same seam auto mode uses — `auto_push`/`auto_pr` stop being auto-only
  preferences in practice.
- **Migration order:** extract Publication first (mechanical tail-split, low
  blast radius), then move the stash choreography into `exitMilestone`, then
  relocate the merge core. Each step is independently shippable and
  behaviour-neutral.

## Implementation status (2026-06-10)

**Shipped this pass:** step 1 of the migration — `publication.ts`
(`publishMilestone`, `gitRemoteExists`) extracted from the tail of
`mergeMilestoneToMain`, behaviour-neutral (same gating truth table, same
non-fatal failure handling, same log messages). Tested against local bare-
remote git fixtures (`tests/publication.test.ts`) — push, suppression under
auto-PR, nothing-to-commit short-circuit, missing remote.

**Remaining:** step 2 (absorb the stash-restore choreography from the four
`auto/phases.ts` call sites into `exitMilestone`) and step 3 (relocate the
merge core out of `auto-worktree.ts` into the Worktree Lifecycle module).
