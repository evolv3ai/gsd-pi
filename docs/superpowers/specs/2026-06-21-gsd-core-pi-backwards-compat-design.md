# Design: gsd-core ↔ gsd-pi Backwards Compatibility

**Status:** Proposed
**Date:** 2026-06-21
**Author:** Design session (Approach 3 — Parity + Property-tested Reconcile)
**Decisions locked (from brainstorming):**

- Coexistence model: both tools maintained long-term; users pick freely per project/per day. Equal support both directions.
- Conflict policy: DB stays canonical inside gsd-pi; markdown (`.gsd/`) is the inter-tool contract. (Option D — "markdown is the contract, DB caches" — was rejected as a multi-quarter rewrite; the agreed middle path keeps DB-authority and adds a compatibility layer.)
- Sync model: startup reconcile + write-time invalidation + git as integration layer. Continuous file-watch sync was rejected as architecturally mismatched to gsd-pi's DB-authoritative design (feedback loops, lossy projection, races, and it still couldn't handle the "gsd-pi closed" case).
- Approach: Approach 3 — finish parity + hash-based compat marker + startup reconcile via the existing ADR-017 drift pipeline + a round-trip property test suite + docs.

---

## 1. Goal

Users of `@opengsd/gsd-core` and `@opengsd/gsd-pi` can open the same project in either tool — including interleaving them across sessions on the same day — and neither tool silently destroys the other's edits to `.gsd/`. The `.gsd/` directory is the shared contract; both tools commit to reading and writing the same files.

## 2. Scope

### In scope

- **State compatibility:** round-tripping `.gsd/` markdown between the two tools without data loss. SQLite stays canonical *inside gsd-pi*; gsd-pi treats markdown as the inter-tool contract.
- **Command parity:** finishing the in-progress port of gsd-core's ~40 slash commands into gsd-pi as native workflows, so gsd-core users get muscle-memory parity in gsd-pi. (Much already in progress in the working tree: `commands-gsd-core.ts`, `gsd-core-aliases.ts`, `gsd-core-aliases-handler.ts`, new `prompts/*.md`, plus edits to `catalog.ts`, `dispatcher.ts`, `handlers/core.ts`, `handlers/ops.ts`.)
- **Reconciliation:** startup auto-reconcile + explicit `/gsd sync` for mid-session tool switches.
- **Safety net:** a round-trip property test suite that catches projection drift before users do.
- **Documentation:** a "switching between GSD tools" how-to.

### Out of scope

- Real-time / continuous file-watch sync (rejected).
- Making the DB non-canonical inside gsd-pi (the full inversion — too large).
- Any changes to `gsd-core` itself. gsd-core stays markdown-only and oblivious; all compatibility work happens in `gsd-pi`.
- Network / cloud / multi-repo sync.
- gsd-core commands that have no `.gsd/`-model equivalent (e.g. agent-runner concepts). Only `.gsd/`-backed commands are in scope for parity.

### Non-goals

We are **not** promising conflict-free concurrent writes. If two tools edit the *same entity* simultaneously, last-writer-per-entity applies and we surface it. Git remains the integration layer for human review.

## 3. Success Criteria

1. **Cross-tool open.** A gsd-core user runs `npx @opengsd/gsd-pi` on an existing gsd-core project, sees their milestones/slices/tasks, and can continue work — no migration step required.
2. **Round-trip preservation.** A gsd-pi user closes the session; a teammate edits `.gsd/plan.md` via gsd-core and commits; the first user reopens gsd-pi and finds those edits imported (with a visible log of what changed).
3. **Property-tested stability.** The round-trip property test suite runs in CI and is green on real-world gsd-core fixture trees.
4. **Doctor health.** `gsd doctor` reports "compat health: OK" on a project that has been round-tripped ≥5 times across both tools.

## 4. Architecture

### 4.1 Key principle: fold into existing pipelines, don't bolt on

gsd-pi already has three of the four primitives this design needs:

| Need | Existing primitive |
|---|---|
| Detect drift between DB and markdown | `state-reconciliation/` (ADR-017 drift registry) + `markdown-renderer.detectStaleRenders()` |
| Import markdown → DB | `md-importer.migrateFromMarkdown()` / `migrateHierarchyToDb()` |
| Project DB → markdown | `markdown-renderer.renderAllFromDb()` |
| Cross-process serialization | `sync-lock.acquireSyncLock()` / `releaseSyncLock()` |

The design adds **one new drift kind** to the ADR-017 registry and a **single new marker file**. No parallel pipelines.

### 4.2 The compat marker: `.gsd/.compat.json`

A single small JSON file recording the last projection state. Lives under `.gsd/` so both tools see it (gsd-core ignores unknown files).

```json
{
  "schema": 1,
  "lastWriter": "gsd-pi",
  "lastProjectedAt": "2026-06-21T14:03:11.000Z",
  "projections": {
    "roadmap.md": { "sha": "9f2c…", "entities": ["m1", "m2"] },
    "m1/plan.md":  { "sha": "ab31…", "entities": ["m1/s1", "m1/s2"] }
  },
  "piVersion": "1.4.0"
}
```

- **Hash-based, not mtime-based.** mtimes are unreliable across git checkouts, filesystems, and clocks. SHA-256 of normalized file content (trailing whitespace trimmed, CRLF→LF) avoids false positives on cosmetic differences.
- **Per-file entity map.** When drift is detected on `m1/plan.md`, gsd-pi knows which DB entities (slices/tasks) the file projects. Current repair still runs an idempotent whole-tree import, but derives a milestone scope from these entities so only the drifted milestone(s) can contribute markdown checkbox status.
- `lastWriter` is `"gsd-pi"` after every gsd-pi projection; gsd-core never writes it (it's oblivious), so a missing/stale marker is itself a signal: "the other tool may have written since my last projection."
- `schema: 1` for forward compatibility of the marker format itself.

### 4.3 New drift kind: `external-markdown-edit`

Added to the `DriftRecord` union in `state-reconciliation/types.ts`:

```ts
| {
    kind: "external-markdown-edit";
    projectionPath: string;       // relative to basePath, e.g. "m1/plan.md"
    expectedSha: string;          // from .compat.json
    actualSha: string;            // freshly computed
    entities: string[];           // entity ids used to scope status authority
  }
```

Detection (`detect`) compares each projection's recorded sha against the current normalized file hash. Differences become `external-markdown-edit` records.

Repair (`repair`) re-imports markdown → DB through the existing `md-importer` whole-tree upsert path, with status authority scoped to the milestone ids in the drifted marker entry. That prevents a stale, unrelated projection from reverting DB status while keeping the repair idempotent (re-running yields the same outcome, which is what the cap=2 reconcile loop requires).

### 4.4 Startup reconcile flow

```
gsd-pi startup
  ├─ acquire sync-lock
  ├─ read .gsd/.compat.json (or treat missing as "everything is external")
  ├─ reconcileBeforeDispatch(basePath)   ← existing ADR-017 pipeline
  │     └─ new external-markdown-edit handler imports edits → DB
  ├─ renderAllFromDb(basePath)           ← project DB → markdown
  ├─ write fresh .gsd/.compat.json
  ├─ emit structured "what changed" log to workflow-logger
  └─ release sync-lock
```

Runs once per session start. Bounded cost. No watcher.

### 4.5 Mid-session switch: `/gsd sync`

Wraps the same pipeline (lock → reconcile → render → write marker → log) so a user who switches tools mid-session can pull in the other tool's edits without restarting. Reuses the dispatcher/catalog plumbing already in place for the parity commands.

### 4.6 Write-time invalidation (the "while gsd-pi runs" case)

`renderAllFromDb` and friends already call `invalidateCaches()` / `clearParseCache()` after every projection write. The same hook updates the relevant entry in `.gsd/.compat.json` so the next reconcile pass doesn't flag gsd-pi's own writes as external. This is the feedback-loop-prevention mechanism that continuous-watch sync would have needed and couldn't cleanly get.

### 4.7 Command parity (finishing the in-progress work)

The uncommitted `commands-gsd-core.ts` ports gsd-core's slash commands as gsd-pi native workflows backed by the new `prompts/*.md` templates. The design's contribution here is a **parity verification matrix** (Section 5.3): a table mapping each gsd-core command → its gsd-pi native equivalent → a smoke test, so we can prove parity rather than assert it.

### 4.8 Round-trip property test suite (the real safety net)

Property: **for any gsd-core `.gsd/` fixture, `import → render → import` must be stable** (the second import produces a DB byte-identical to the first, modulo timestamps). Placed under `src/resources/extensions/gsd/__tests__/round-trip/` with fixtures sourced from real gsd-core project trees (committed under `__fixtures__/`).

Catches exactly the lossy-projection bugs (whitespace, ordering, escaping, missing fields) that would otherwise silently destroy state. This is what makes any of the above safe to ship.

## 5. Components

### 5.1 New / changed files

| File | Change | Purpose |
|---|---|---|
| `src/resources/extensions/gsd/state-reconciliation/types.ts` | Add `external-markdown-edit` to `DriftRecord` union | New drift kind |
| `src/resources/extensions/gsd/state-reconciliation/drift/external-markdown-edit.ts` | **New** | `DriftHandler` for the new kind (detect + idempotent repair) |
| `src/resources/extensions/gsd/state-reconciliation/registry.ts` | Register the new handler | Wire into ADR-017 pipeline |
| `src/resources/extensions/gsd/compat/compat-marker.ts` | **New** | Read/write `.gsd/.compat.json`; sha computation + normalization |
| `src/resources/extensions/gsd/compat/index.ts` | **New** | Public exports for the compat module |
| `src/resources/extensions/gsd/md-importer.ts` | Expose entity-level upsert helpers (some already exported) | Repair path needs per-entity import, not full-tree migrate |
| `src/resources/extensions/gsd/markdown-renderer.ts` | Update `.compat.json` entry on each projection write (in the existing `invalidateCaches` callback chain) | Write-time invalidation |
| `src/resources/extensions/gsd/commands/handlers/ops.ts` | Wire `/gsd sync` to the reconcile→render→marker pipeline | Mid-session switch |
| `src/resources/extensions/gsd/commands/handlers/ops.ts` | Extend `/gsd doctor` with a "compat health" check | Success criterion #4 |
| `src/resources/extensions/gsd/__tests__/round-trip/` | **New** | Property test suite + fixtures |
| `docs/how-to/switching-between-gsd-tools.md` | **New** | User-facing workflow doc |

### 5.2 Module boundaries

The `compat/` module owns: marker schema, read/write, hash normalization. It exposes exactly two functions to the rest of the codebase:

- `readCompatMarker(basePath): CompatMarker | null`
- `writeCompatMarker(basePath, marker): void`

Everything else (drift detection, repair, rendering) stays in its existing module. The compat module has no dependency on the drift registry — the drift handler depends on *it*, not the reverse.

### 5.3 Parity verification matrix (sample; full table built during implementation)

| gsd-core command | gsd-pi native | Smoke |
|---|---|---|
| `/gsd plan` | `/gsd plan` (ported) | opens planner on fresh `.gsd/` |
| `/gsd explore` | `/gsd explore` (ported) | reads `CONTEXT.md` |
| `/gsd milestone-summary` | `/gsd milestone-summary` (ported) | renders from DB |
| … (~40 rows) | … | … |

## 6. Data Flow

**Cross-tool open (gsd-core → gsd-pi):**

1. gsd-pi starts; sync-lock acquired.
2. `reconcileBeforeDispatch` runs; `external-markdown-edit` detector finds files where current sha ≠ `.compat.json` sha (or marker absent → treat all projection files as external).
3. Repair imports markdown → DB with status authority scoped to the drifted file's marker entities.
4. `renderAllFromDb` re-projects everything.
5. `.compat.json` rewritten with fresh shas, `lastWriter: "gsd-pi"`.
6. Lock released; workflow-logger emits a structured diff of imported changes.

**Mid-session switch (`/gsd sync`):** identical pipeline, invoked on demand.

**Within gsd-pi:** every projection write updates `.compat.json` in the existing invalidation callback; next reconcile sees gsd-pi's own writes as expected.

## 7. Error Handling

- **Missing `.compat.json`:** treat every projection file as external → full reconcile. Worst case is a redundant import; never a data-loss path.
- **Malformed `.compat.json`:** quarantine to `.gsd/.compat.json.bad-<ts>` (never overwrite without backup), start fresh.
- **Hash collision / sha failure:** catch, log via `workflow-logger.logWarning`, fall back to full reconcile.
- **Import error on a specific entity:** the ADR-017 pipeline already collects per-record failures without aborting the pass; we follow the same pattern — record the failure, continue, surface in the result.
- **Lock contention:** `sync-lock` already handles this; reconcile refuses to run concurrently. Two gsd-pi instances editing one project is already out of scope.
- **Concurrent same-entity writes by both tools (true race):** last-writer-per-entity after reconcile; surfaced in the workflow-logger as a "conflict resolved" entry. Git review remains the human safety net.

## 8. Testing

- **Property suite (Section 4.8):** the load-bearing safety net. CI-gated.
- **Unit tests:** `compat-marker` (schema migration, normalization determinism); the new `external-markdown-edit` handler (detect + idempotent repair).
- **Integration test:** simulate the cross-tool open flow on a fixture — start with gsd-core fixture, run reconcile, assert DB + markdown reflect imported edits, re-run reconcile, assert no-op.
- **Doctor test:** after N round-trips, `gsd doctor` compat-health is OK.
- **Existing test parity:** `verify:full` must stay green (this is a repo-wide gate per recent commits `3cced9dc`, `5326e960`).

## 9. Rollout

- Behind no feature flag — `.gsd/.compat.json` is additive and gsd-core ignores it.
- Marker schema versioned (`schema: 1`) so future format changes are migratable.
- If `.compat.json` is deleted, gsd-pi regenerates it on next startup (full reconcile).
- Docs shipped alongside code so users have the "commit before switching" workflow from day one.

## 10. Open Questions for Implementation

- Exact normalization rules for sha (CRLF→LF confirmed; trailing-whitespace trim confirmed; anything else — e.g. comment reordering, frontmatter keys — to be settled during property-test authoring, where unstable mappings will surface as test failures).
- Whether `/gsd sync` should accept a `--dry-run` flag (low cost, useful; default yes).
- Fixture sourcing: real gsd-core project trees from `open-gsd/gsd-core` test corpus vs. synthetic. Prefer real; confirm licensing during implementation.
