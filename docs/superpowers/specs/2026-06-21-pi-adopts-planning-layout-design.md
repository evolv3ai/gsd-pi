# Design: gsd-pi adopts `.planning/` as its unified on-disk layout

**Status:** Proposed
**Date:** 2026-06-21
**Author:** Design session
**Worktree:** `gsd-pi-pi-adopts-planning-layout` on branch `feat/pi-adopts-planning-layout`
**Supersedes:** The bridge/compat layer shipped in PR #802 (`.gsd/` ↔ `.planning/` parity). That work becomes the migration mechanism, not a permanent bridge.

---

## 1. Goal

gsd-pi adopts gsd-core's `.planning/` flat layout as its **sole on-disk contract**. Both tools read and write the same directory with the same structure. A user can open any project in either tool, freely, with no bridge, marker, or drift detection. One layout — not two layouts bridged.

## 2. Decisions locked (from brainstorming)

1. **One unified layout.** Both tools read/write the same directory, same internal structure.
2. **gsd-pi adopts `.planning/`.** gsd-core untouched.
3. **Tasks dropped on disk.** Task files (`TID-PLAN.md`, `TID-SUMMARY.md`) stop being written. Tasks become checkboxes inside plan files (gsd-core's `<tasks>` XML model). The DB keeps the task table for dispatch; only the on-disk representation changes.
4. **DB stays as-is.** SQLite stays as gsd-pi's internal index/cache, relocated to `.planning/gsd.db`. No schema change. Tables keep `milestone_id`/`slice_id`/`task_id` columns and names; code keeps those names internally.
5. **Auto-migrate on startup.** If gsd-pi detects `.gsd/` with no `.planning/`, it backs up `.gsd/`, writes `.planning/` from the DB, leaves `.gsd/` read-only for one release.
6. **Approach: layout-policy layer.** A single module owns the layout decisions; all 17 path resolvers delegate to it. The 580 call sites don't change (they call the same resolvers, which now return `.planning/...`). Function names stay (`resolveMilestonePath` etc.); only their internals change.

## 3. Scope

### In scope

- **Layout-policy module** (`layout-policy.ts`) — single source of truth for the root dir, segment names, file-naming, and DB path.
- **Path layer migration** — the 17 resolvers in `paths.ts` route through the policy; ~6 hardcoded literals in `paths.ts`, ~3 in `markdown-renderer.ts`, ~3 in `md-importer.ts` move behind the policy.
- **Tasks collapse** — task files stop being written; task content lives as checkboxes inside plan files (`<tasks>` XML blocks). The DB keeps the task table; only the on-disk representation changes.
- **DB relocation** — `gsd.db` moves from `.gsd/gsd.db` to `.planning/gsd.db`. No schema change.
- **Startup auto-migration** — `.gsd/` → `.planning/` with backup + safety net.
- **Prompt string update** — `auto-prompts.ts` (154 path references) and other prompt emitters say `.planning/phases/...` instead of `.gsd/milestones/...`.
- **Compat layer removal** — `.gsd/.compat.json` marker, `external-markdown-edit`/`external-planning-edit` drift handlers, `/gsd sync`, and doctor compat-health removed. The parity work from PR #802 becomes the migration mechanism, not a permanent bridge.

### Out of scope

- **gsd-core changes.** Untouched.
- **DB schema rename.** Tables stay `milestones`/`slices`/`tasks` with their columns. Code keeps those names internally.
- **Multi-milestone / legacy-milestone-dir bidirectional support.** Those layouts still import correctly (read path unchanged) but aren't reverse-projected — same v1 limitation as today, now acceptable because the default layout is unified.

### Non-goals

- Conflict-free concurrent writes. Last-writer-per-entity still applies; git is the human safety net.
- Dropping the DB. The DB stays as the internal index; only the on-disk markdown contract changes.

## 4. Architecture

### 4.1 The layout-policy module

The keystone of the design. A single module owns four decisions:

```ts
// layout-policy.ts

// 1. Root directory name
export const LAYOUT_ROOT = ".planning";  // was ".gsd"

// 2. Segment names (the hierarchy levels)
export const LAYOUT_SEGMENTS = {
  level1: "phases",  // was "milestones"
  // plans are files inside level1 dirs, not a subdir — gsd-core flattens this
} as const;

// 3. File-naming policy
export function phaseDirName(phaseNum: number, slug: string): string {
  return `${pad(phaseNum)}-${slug}`;                    // "01-foundation"
}
export function planFileName(phaseNum: number, planNum: number, suffix: string): string {
  return `${pad(phaseNum)}-${pad(planNum)}-${suffix}.md`;  // "01-01-PLAN.md"
}

// 4. DB path
export function dbPath(basePath: string): string {
  return join(basePath, LAYOUT_ROOT, "gsd.db");
}

// Helpers
function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}
```

The resolvers in `paths.ts` switch to reading from the policy:

```ts
// paths.ts — before
export function resolveMilestonePath(basePath, mid) {
  return join(gsdProjectionRoot(basePath), "milestones", mid);
}

// paths.ts — after (delegates to policy)
import { LAYOUT_ROOT, LAYOUT_SEGMENTS } from "./layout-policy.js";

export function resolveMilestonePath(basePath, mid) {
  return join(layoutRoot(basePath), LAYOUT_SEGMENTS.level1, mid);
}
```

**Function names stay** (`resolveMilestonePath`, `resolveSlicePath`, etc.). They're called from ~580 sites; renaming them is churn that doesn't serve the goal. Code still says "milestone" internally; disk says "phase."

### 4.2 The tasks collapse

This is the only structural hierarchy change. Today gsd-pi is three levels on disk:

```
.gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md
```

After, it's two levels, matching gsd-core:

```
.planning/phases/01-foundation/01-01-PLAN.md
```

Task content lives inside the plan file as a `<tasks>` XML block (gsd-core's native model):

```markdown
# 01-01: Set up tooling

<objective>
Set up the build tooling.
</objective>

<tasks>
- [ ] **T01**: Init repo _(30m)_
- [x] **T02**: Add CI _(15m)_
</tasks>

<verification>
Build runs and CI is green.
</verification>
```

What changes:
- `resolveTasksDir`, `resolveTaskFile` → deprecated (return null or removed).
- `renderTaskPlanFromDb` → removed. Task state renders inside `renderPlanFromDb`'s `<tasks>` block.
- `renderTaskSummary` → removed as a *separate file writer*. Task-level summary content (verification evidence, key files, key decisions) that dispatch uses stays in the DB; on disk it renders into the plan file's `<verification>` block (per-task detail) or the slice/phase SUMMARY. No data is lost — the DB remains the store; only the per-task-file projection goes away.
- `parsePlan` (legacy parser) already extracts `<tasks>` — the read path works as-is. Task completion status is parsed from checkbox state.
- The DB's task table stays. Auto-mode dispatch (`auto-dispatch.ts`) still assigns work at task granularity using DB state; it just no longer reads/writes individual task files. Task completion status on disk = checkbox state in the plan file, parsed back into the DB on import.

**Boundary:** DB = task-granular (authoritative for dispatch). Disk = plan-granular (gsd-core-compatible contract). The renderer translates DB → disk; the importer translates disk → DB.

### 4.3 DB relocation

`gsd.db` moves from `.gsd/gsd.db` to `.planning/gsd.db`. gsd-core ignores it (it preserves unknown files). No schema change; the open path changes in one place (`db-workspace.ts`).

### 4.4 Startup auto-migration

On startup, gsd-pi checks for the legacy layout:

1. **Detect:** `.gsd/gsd.db` exists AND `.planning/` does not.
2. **Backup:** `cpSync(.gsd/, .gsd-backups/migrate-<ts>/)` — full copy, reversible.
3. **Transform:** open the DB, read all milestones/slices/tasks, emit `.planning/` via the reverse writer (the broadened `planning-writer.ts` from PR #802).
4. **Relocate DB:** move `gsd.db` from `.gsd/` to `.planning/`.
5. **Leave `.gsd/` in place read-only** for one release as a safety net.
6. **Notice:** one-time user-facing message about the migration, the backup location, and the upcoming `.gsd/` removal.

The migration reuses existing infrastructure in reverse: `parsePlanningDirectory` reads the *new* `.planning/` (post-migration) to verify the round-trip; if counts mismatch, it refuses and restores from backup.

### 4.5 Compat-layer removal

| Component | Fate |
|---|---|
| `compat/compat-marker.ts` + `.gsd/.compat.json` | **Removed** |
| `external-markdown-edit` drift handler | **Removed** |
| `external-planning-edit` drift handler | **Removed** |
| `planning-writer.ts` | **Kept** — becomes the renderer for `.planning/` and the migration writer |
| `layout-detect.ts` | **Kept** — used by migration |
| `/gsd sync` command | **Removed** |
| `/gsd doctor` compat-health line | **Removed** |
| Round-trip property suite (`.gsd/` fixtures) | **Replaced** — `.planning/`-only fixtures |
| `docs/user-docs/switching-between-gsd-tools.md` | **Replaced** — "Unified `.planning/` layout" doc |

The `state-reconciliation` drift pipeline stays — it's used for other drift kinds (stale-render, roadmap-divergence, etc.). Only the two external-edit handlers and the marker go.

## 5. Components (files touched)

### New

| File | Responsibility |
|---|---|
| `src/resources/extensions/gsd/layout-policy.ts` | Root dir, segment names, file-naming, DB path |

### Modified

| File | Change |
|---|---|
| `src/resources/extensions/gsd/paths.ts` | 17 resolvers delegate to layout-policy; ~6 literals move |
| `src/resources/extensions/gsd/markdown-renderer.ts` | Renderer emits `.planning/` paths via policy; tasks render as `<tasks>` blocks inside plans; ~3 hardcodes move |
| `src/resources/extensions/gsd/md-importer.ts` | Importer reads `.planning/` paths via policy; ~3 hardcodes move |
| `src/resources/extensions/gsd/db-workspace.ts` | DB path → `.planning/gsd.db` |
| `src/resources/extensions/gsd/auto-prompts.ts` | 154 path references: `.gsd/milestones/...` → `.planning/phases/...` |
| `src/resources/extensions/gsd/detection.ts` | `.gsd/` detection becomes legacy detection; `.planning/` is primary |
| `src/resources/extensions/gsd/commands-maintenance.ts` | `handleSync` removed; migration flow added |
| `src/resources/extensions/gsd/commands-handlers.ts` | Doctor compat-health removed |
| `src/resources/extensions/gsd/state-reconciliation/registry.ts` | Remove the two external-edit handlers |
| `src/resources/extensions/gsd/state-reconciliation/types.ts` | Remove `external-markdown-edit` / `external-planning-edit` variants |

### Removed

| File | Reason |
|---|---|
| `src/resources/extensions/gsd/compat/compat-marker.ts` | No drift to track |
| `src/resources/extensions/gsd/compat/index.ts` | Empty |
| `src/resources/extensions/gsd/compat/planning-compat.ts` | Marker activation logic obsolete |
| `src/resources/extensions/gsd/state-reconciliation/drift/external-markdown-edit.ts` | No external edits when layout is unified |
| `src/resources/extensions/gsd/state-reconciliation/drift/external-planning-edit.ts` | Same |
| `src/resources/extensions/gsd/tests/compat-marker.test.ts` | Obsolete |
| `src/resources/extensions/gsd/tests/planning-marker.test.ts` | Obsolete |
| `src/resources/extensions/gsd/tests/external-markdown-edit.test.ts` | Obsolete |
| `src/resources/extensions/gsd/tests/external-planning-edit.test.ts` | Obsolete |

## 6. Data Flow

**Normal operation (post-migration):**
1. gsd-pi reads/writes `.planning/phases/NN-slug/NN-MM-PLAN.md` via the layout-policy-backed resolvers.
2. DB at `.planning/gsd.db` is the internal index; dispatched from but not the on-disk contract.
3. Tasks live as checkboxes in plan files; parsed into the DB on import; rendered from DB on projection.
4. No compat marker, no drift detection for external edits — both tools write the same layout.

**Startup migration (one-time, for existing `.gsd/` users):**
1. Detect `.gsd/` + no `.planning/`.
2. Backup `.gsd/` to `.gsd-backups/`.
3. Read DB, write `.planning/` via reverse writer.
4. Move `gsd.db` to `.planning/`.
5. Leave `.gsd/` read-only for one release.

**Cross-tool open (the goal state):**
- gsd-core opens the project: reads `.planning/`, works natively.
- gsd-pi opens the project: reads `.planning/`, populates/refreshes DB, works natively.
- No conversion, no bridge, no drift.

## 7. Error Handling

- **Migration failure (counts mismatch):** refuse, restore `.gsd/` from backup, surface error. Never leave a half-migrated project.
- **Migration failure (disk full / permission):** refuse, restore, surface. The backup is the safety net.
- **Missing `.planning/` after migration (user deleted it):** gsd-pi falls back to `.gsd-backups/` and re-migrates. If backup also missing, surface "project state lost — restore from git."
- **Concurrent same-entity edits:** last-writer-per-entity; git is the human safety net.

## 8. Testing

- **Layout-policy unit tests** — root, segment names, file naming, DB path.
- **Path-resolver tests** — the 17 resolvers return `.planning/...` paths.
- **Tasks-as-checkboxes tests** — `renderPlanFromDb` emits `<tasks>` blocks; `parsePlan` extracts them back; task status round-trips.
- **Migration tests** — `.gsd/` fixture → migrate → `.planning/` fixture; counts match; backup created; idempotent (second migration is a no-op).
- **Round-trip property suite** — `.planning/`-only fixtures; import → render → import stable. This is now trivially stable because both directions use the same layout.
- **Regression:** `state-reconciliation-drift` (minus the removed handlers), `markdown-renderer`, `gsd-recover`, `gsd-rebuild` stay green.

## 9. Rollout

- **Behind no feature flag.** The layout-policy module is additive; migration is automatic on first startup.
- **One-release `.gsd/` safety net.** The old dir stays read-only for one release, then a follow-up release deletes it.
- **Version bump.** This is a breaking change for existing gsd-pi users (on-disk layout changes). Minor version bump minimum; the migration is automatic but the change is visible.
- **Docs shipped alongside.** The unified-layout doc replaces the switching-between-tools doc.

## 10. Open Questions for Implementation

- **`auto-prompts.ts` churn (154 refs).** This is the largest single-file change. Decide whether to do it with a careful search-replace (risky — prompt strings have subtle formatting) or a layout-policy-backed helper that emits the relative path strings. Lean toward the helper to avoid touching 154 lines individually.
- **Tasks-as-checkboxes ↔ DB sync.** When a user checks a task box in gsd-core (editing the plan file), the importer must update the DB's task status. Confirm `parsePlan` → `migrateHierarchyToDb` already does this, or add the mapping.
- **Migration writer scope.** `planning-writer.ts` from PR #802 handles flat-phases only. The migration must handle any gsd-pi project (milestone/slice/task hierarchy), so the writer needs broadening to emit all milestones/slices as phases/plans. This is the existing `writePlanningDirectory` signature, just with the tasks-collapse logic added.
- **`.gsd/` read-only enforcement.** Decide whether to literally chmod/flag the dir or just document that writes there are ignored. Lean toward documentation — filesystem enforcement is fragile cross-platform.
