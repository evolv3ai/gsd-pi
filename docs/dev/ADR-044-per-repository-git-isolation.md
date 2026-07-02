<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR (proposed) for per-repository git isolation in parent workspaces — records the Tier A (push policy) / Tier B (worktree/branch isolation) split and why Tier B needs an RFC. -->

# ADR-044: Per-Repository Git Isolation (Parent Workspace)

**Status:** Proposed — Tier B requires an RFC before adoption (see "Trigger")
**Date:** 2026-07-01
**Author:** GSD architecture review
**Related:** [open-gsd/gsd-pi#818](https://github.com/open-gsd/gsd-pi/issues/818) (parent-workspace epic, Gap 4), ADR-043 (parent-workspace mode contract), ADR-001 (branchless worktree architecture), `CONTEXT.md` worktree lifecycle

## Context

### What Gap 4 asks for — and what already works

The parent-workspace epic's fourth gap: *"Extend git isolation per repository. Allow worktree/branch isolation and commit/push strategy to be resolved per child repo (using `commit_policy` and a per-repo branch/push policy), not just at the root."*

**The gap is narrower than that framing suggests.** The issue's two stated Gap 4 use cases are **already delivered** by code that predates the epic:

| Issue use case | Mechanism | Status |
|---|---|---|
| "a slice verified and committed in its own repo" | per-repo verification (`auto-verification.ts`, `cwd: repo.root`) + per-repo commit (`runPerRepositoryCommitAction`) | ✅ wired |
| "`commit_policy: skip` on `infra` … never auto-commits there" | per-repo `commit_policy` (`git-service.ts`, `if (repo.commitPolicy === "skip") skip`) | ✅ wired |

So a contributor picking up "Gap 4" should **not** rebuild per-repo commit or verification — they already loop the registry. What genuinely remains is the one piece the issue's *description* mentions but its *use cases* do not exercise: **per-repo worktree/branch/push isolation.** That is the subject of the Tier A / Tier B split below.

### Why the remaining gap is two distinct problems

The existing seam splits cleanly along the commit axis vs. the isolation/push axis:

- **Per-repo commit and verification already loop.** `runPerRepositoryCommitAction` (`git-service.ts`) commits per declared repository, honoring each repo's `commit_policy` (`auto`/`skip`); `collectRepositoryDirtyStatus` probes each repo independently; verification runs with `cwd: repo.root`.
- **Branch, worktree, and push do not.** The milestone branch is `milestone/<MID>` (single, repo-agnostic — `auto-worktree.ts:846`). The worktree is one per milestone at the project root (`worktree-placement.ts`). `publishMilestone` pushes a single `integrationBranch`/`milestoneBranch` from a single `basePath` with scalar `auto_push`/`push_branches`/`remote` preferences (`publication.ts:67`). The squash-merge transaction is constructed through `milestone-merge-transaction.ts` and remains single-root because its default adapter wraps `mergeMilestoneToMain`.

This is the basis for the Tier A / Tier B split below.

## Decision

### Tier A — per-repository push policy (proposed, lower-risk)

Add per-repo push/branch policy alongside the existing `commit_policy` on `WorkspaceRepositoryPreference`, and loop the registry in `publishMilestone` so push is resolved per declared repository. This is **additive to the existing per-repo commit seam** — it extends the registry and the publication path, both of which already have a per-repo dimension.

Tier A does **not** touch worktree creation, branch-mode entry, the session root, or the merge transaction.

### Tier B — per-repository worktree/branch isolation (NOT adopted; RFC required)

Inverting the one-worktree-per-milestone model to one-worktree-per-repo-per-milestone is an architectural change that crosses the systems CONTRIBUTING.md flags as RFC-trigger zones (`auto-mode`, `agent-core`, `orchestration`). Specifically it would require changing:

| Concern | Location | Why it's load-bearing |
|---|---|---|
| Isolation mode resolution | `preferences.ts` (`getIsolationMode`) | Global pref; would need to become per-repo |
| Worktree creation | `auto-worktree.ts` (`createAutoWorktree`) | Single `basePath`, single `chdir`, single `activeWorkspace` |
| Branch-mode entry | `auto-worktree.ts` (`enterBranchModeForMilestone`) | Single `basePath` |
| Milestone entry dispatch | `worktree-lifecycle.ts` (`_enterMilestoneCore`) | Resolves a single `mode` per milestone |
| Per-turn safety validation | `orchestrator.ts` (`prepareWorktreeForUnit`) | `buildExpectedBranch` returns one branch |
| Merge transaction | `milestone-merge-transaction.ts` → `auto-worktree.ts` (`mergeMilestoneToMain`) | Single squash-merge, branch delete, worktree remove |
| Session root / `activeWorkspace` | `auto-worktree.ts` | A singleton; per-repo worktrees break the "one active workspace" invariant |

The deepest blocker is the **session-root singleton**: the agent runs in one working directory (`process.chdir` to one `activeWorkspace`). Per-repo worktrees would require either multiple concurrent cwd contexts (breaks agent-core) or a primary-worktree-plus-per-repo-branch-checkouts model. Either is a design-level change to the isolation lifecycle, not a surgical edit.

**Blast-radius note:** Tier B only affects teams that opt into `git.isolation: "worktree"` or `"branch"` — the default is `"none"` (`preferences.ts:1042`), under which there is no worktree to make per-repo and per-repo commit/verification already work as-is. So Tier B is RFC-grade both because of the systems it touches and because it serves a non-default configuration.

Tier B is **recorded here, not implemented**. It should go through the RFC/ADR review process with a concrete design for the session-root question before any code lands.

## Consequences

- **The substance of Gap 4 is already delivered.** The issue's two stated use cases (per-repo verify+commit, `commit_policy: skip`) work today via the existing per-repo commit/verification loops — no part of this ADR is required to satisfy them. A future contributor should treat that as done.
- **Tier A** (per-repo push policy) is *beyond the issue's stated scope* — the use cases don't mention push — but is a low-blast-radius option (e.g. "push `frontend` and `backend` but never push `infra`") if a real need surfaces. Recorded, not built, per the simplicity-first rule.
- **Tier B remains open.** Until it is designed and approved via RFC, parent-workspace *worktree/branch isolation* stays root-only: one worktree/branch per milestone at the project root, shared across child repos. This only matters under `git.isolation: worktree|branch`; under the default `none`, per-repo commit/verification already work. Documented as a known limit in `docs/user-docs/multi-repo-workspace.md`.

## Trigger

Tier A may be implemented as a focused slice when a contributor picks up the per-repo push-policy use case. Tier B requires an RFC describing how the session-root singleton and the merge transaction accommodate per-repo isolation before implementation begins.
