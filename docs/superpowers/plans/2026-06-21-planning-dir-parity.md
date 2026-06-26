# `.planning/` Round-Trip Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped `.gsd/` compat layer (PR #802) to cover gsd-core's `.planning/` layout, so users can round-trip the same project across both tools regardless of which layout they use.

**Architecture:** Reuse the existing read path (`migrate/parsePlanningDirectory` + `transformToGSD`). Build the missing write path (`planning-writer.ts`). Extend the compat marker schema 1→2 with a `planning` field. Add a new drift kind `external-planning-edit` mirroring the shipped `external-markdown-edit`. Un-modeled docs are pass-through: sha-tracked, never re-rendered.

**Design spec:** `docs/superpowers/specs/2026-06-21-planning-dir-parity-design.md`

## Tasks (TDD, 8 tasks)

1. **Marker schema 1→2 + `planning` field** — extend `CompatMarker` with optional `planning: { active, layout, projections, passthrough }`. Schema-1 markers promoted (planning defaults inactive) not quarantined.
2. **Layout detector** (`migrate/layout-detect.ts`) — pure function extracting the implicit 3-way branch from `transformToGSD`.
3. **Planning writer** (`migrate/planning-writer.ts`) — DB → `.planning/` projection. v1 supports `flat-phases` only.
4. **`external-planning-edit` drift handler** — mirrors `external-markdown-edit`. Passthrough files refresh sha only.
5. **Hook `writePlanningDirectory` into `renderAllFromDb`** — gated on `marker.planning.active`.
6. **Extend `/gsd sync` + `/gsd doctor`** — report `.planning/` drift separately.
7. **Round-trip property suite** — fixture `planning-flat-phases`.
8. **Extend user doc + final verification**.

## v1 scope limitation

Only `flat-phases` layout supported for round-trip projection. `multi-milestone` and `legacy-milestone-dir` throw a clear error until fixtures validate the reverse-mapping.

Full task detail with code is in the conversation that produced this plan.
