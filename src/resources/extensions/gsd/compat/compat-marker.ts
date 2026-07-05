// Project/App: gsd-pi
// File Purpose: gsd-core ↔ gsd-pi compatibility marker (`.gsd/.compat.json`).
//
// Records per-projection content hashes so the ADR-017 reconcile pipeline can
// distinguish gsd-pi's own writes (expected) from external edits made by gsd-core
// (drift to import). gsd-core is oblivious to this file and ignores it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Current marker schema version. Bump on breaking format changes + migrate. */
export const COMPAT_MARKER_SCHEMA = 2;

/**
 * Which `.planning/` layout a project uses. Captured on first read so the
 * round-trip writer recreates the same structure gsd-core wrote. Priority
 * matches migrate/transformer.ts transformToGSD.
 */
export type PlanningLayout = "flat-phases" | "multi-milestone" | "legacy-milestone-dir";

/**
 * `.planning/` projection tracking. `projections` are modeled files (roadmap,
 * plans, summaries, state) that get re-imported on drift; `passthrough` are
 * un-modeled docs (DISCUSSION-LOG, PATTERNS, REVIEWS, codebase/) that get sha-
 * refreshed only — content never re-rendered.
 */
export interface PlanningMarker {
  active: boolean;
  layout: PlanningLayout | null;
  projections: Record<string, ProjectionEntry>;
  passthrough: Record<string, ProjectionEntry>;
}

/**
 * Per-file projection entry. `sha` is a normalized-content SHA-256; `entities`
 * is the list of DB entity ids (milestone/slice/task) that the file projects,
 * so repair can scope re-import rather than re-importing the whole tree.
 */
export interface ProjectionEntry {
  sha: string;
  entities: string[];
}

export interface CompatMarker {
  schema: number;
  lastWriter: "gsd-pi";
  lastProjectedAt: string;
  projections: Record<string, ProjectionEntry>;
  /** Optional: `.planning/` layout tracking for gsd-core parity. */
  planning?: PlanningMarker;
  piVersion: string;
}

/** Marker returned when no marker exists yet (fresh project, first gsd-pi run). */
export const EMPTY_MARKER: CompatMarker = {
  schema: COMPAT_MARKER_SCHEMA,
  lastWriter: "gsd-pi",
  lastProjectedAt: "",
  projections: {},
  planning: { active: false, layout: null, projections: {}, passthrough: {} },
  piVersion: "",
};

export function compatMarkerPath(basePath: string): string {
  return join(basePath, ".gsd", ".compat.json");
}

/**
 * Normalize markdown content before hashing so cosmetic differences (trailing
 * whitespace, CRLF) don't produce false-positive drift. Conservative: only
 * transforms that are provably round-trippable through gsd-pi's projection.
 */
export function normalizeForHash(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
}

export function computeProjectionSha(content: string): string {
  return createHash("sha256").update(normalizeForHash(content)).digest("hex").slice(0, 16);
}

/**
 * Read & validate the marker. A missing marker → EMPTY_MARKER (treat every
 * projection as external on next reconcile). A malformed marker is quarantined
 * to `.compat.json.bad-<ts>` (never overwrite without backup) then returns
 * EMPTY_MARKER. A schema-mismatch returns EMPTY_MARKER (forward-compat: refuse
 * to act on a future format we don't understand).
 */
export function readCompatMarker(basePath: string): CompatMarker {
  const path = compatMarkerPath(basePath);
  if (!existsSync(path)) return emptyMarker();

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return emptyMarker();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantine(basePath, raw);
    return emptyMarker();
  }

  if (!isValidMarker(parsed)) {
    quarantine(basePath, raw);
    return emptyMarker();
  }
  // Promote older markers by defaulting absent fields. Schema 1 → 2 only adds
  // the optional `planning` field; treat its absence as planning-inactive so
  // existing PR #802 users upgrade transparently. (A future schema 3 would
  // need an explicit migration here; for now anything that passes isValidMarker
  // is safe to read.)
  if (!parsed.planning) {
    parsed.planning = { active: false, layout: null, projections: {}, passthrough: {} };
  }
  return parsed;
}

/**
 * Fresh deep copy of EMPTY_MARKER. Callers mutate the returned `projections`
 * object (e.g. repair refreshes an entry), so a shallow copy would share the
 * reference and pollute the module constant across calls. Always deep-copy.
 */
function emptyMarker(): CompatMarker {
  return {
    schema: EMPTY_MARKER.schema,
    lastWriter: EMPTY_MARKER.lastWriter,
    lastProjectedAt: EMPTY_MARKER.lastProjectedAt,
    projections: {},
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: EMPTY_MARKER.piVersion,
  };
}

/**
 * Write the marker atomically (write-temp then rename) so a crash mid-write
 * can't leave a half-written file that next startup would quarantine.
 */
export function writeCompatMarker(basePath: string, marker: CompatMarker): void {
  const path = compatMarkerPath(basePath);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2), "utf-8");
  renameSync(tmp, path);
}

/**
 * Remove projection entries whose backing file no longer exists on disk.
 *
 * gsd-pi never deletes marker entries on its own: both drift detectors skip
 * files missing from disk (`if (!existsSync(abs)) continue;`) and the write-time
 * flush only ever adds or refreshes entries. So when a phase directory is
 * renamed or removed (e.g. `phases/29-new-milestone-m029/` →
 * `phases/29-frontend-code-debt-cleanup/`), the old projection paths linger in
 * `.compat.json` forever as phantom entries pointing at directories that no
 * longer exist (#1257). They never reconcile, and `.compat.json` keeps drifting
 * from disk reality so `git status` stops being a reliable proxy for "did the
 * engine touch my plans?".
 *
 * This prunes those orphaned entries across the `.gsd/` projections and the
 * `.planning/` projections/passthrough maps. It is safe: a missing-file entry is
 * inert (every detector already ignores it), and if the file is later
 * re-projected the write-time flush / unseeded-file detection re-seeds an
 * accurate baseline.
 *
 * Returns the number of entries removed; when nothing is orphaned the marker is
 * left untouched (no needless write, no `lastProjectedAt` churn).
 */
export function pruneOrphanedProjectionEntries(basePath: string): number {
  if (!existsSync(compatMarkerPath(basePath))) return 0;

  const marker = readCompatMarker(basePath);
  let removed = 0;

  const pruneMap = (map: Record<string, ProjectionEntry>, root: string): void => {
    for (const relPath of Object.keys(map)) {
      if (!existsSync(join(basePath, root, relPath))) {
        delete map[relPath];
        removed++;
      }
    }
  };

  pruneMap(marker.projections, ".gsd");
  if (marker.planning) {
    pruneMap(marker.planning.projections, ".planning");
    pruneMap(marker.planning.passthrough, ".planning");
  }

  if (removed > 0) writeCompatMarker(basePath, marker);
  return removed;
}

function quarantine(basePath: string, raw: string): void {
  const path = compatMarkerPath(basePath);
  const badPath = `${path}.bad-${Date.now()}`;
  try {
    mkdirSync(dirname(badPath), { recursive: true });
    try {
      renameSync(path, badPath);
    } catch {
      writeFileSync(badPath, raw, "utf-8");
      unlinkSync(path);
    }
  } catch {
    // Best-effort: if we can't quarantine, leave the original in place — next
    // read will quarantine. Never throw out of marker I/O.
  }
}

function isValidProjectionEntry(x: unknown): x is ProjectionEntry {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.sha !== "string") return false;
  if (!Array.isArray(e.entities) || !e.entities.every((s) => typeof s === "string")) return false;
  return true;
}

function isValidProjectionMap(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  for (const v of Object.values(x as Record<string, unknown>)) {
    if (!isValidProjectionEntry(v)) return false;
  }
  return true;
}

function isValidPlanningMarker(x: unknown): x is PlanningMarker {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  if (typeof p.active !== "boolean") return false;
  if (
    p.layout !== null &&
    !["flat-phases", "multi-milestone", "legacy-milestone-dir"].includes(p.layout as string)
  ) {
    return false;
  }
  if (!isValidProjectionMap(p.projections)) return false;
  if (!isValidProjectionMap(p.passthrough)) return false;
  return true;
}

function isValidMarker(x: unknown): x is CompatMarker {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m.lastWriter !== "gsd-pi") return false;
  if (typeof m.schema !== "number") return false;
  if (typeof m.lastProjectedAt !== "string") return false;
  if (typeof m.piVersion !== "string") return false;
  if (!isValidProjectionMap(m.projections)) return false;
  // planning is optional; when present, must validate.
  if (m.planning !== undefined && !isValidPlanningMarker(m.planning)) return false;
  return true;
}
