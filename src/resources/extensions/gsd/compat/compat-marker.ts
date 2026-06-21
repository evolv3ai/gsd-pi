// Project/App: gsd-pi
// File Purpose: gsd-core ↔ gsd-pi compatibility marker (`.gsd/.compat.json`).
//
// Records per-projection content hashes so the ADR-017 reconcile pipeline can
// distinguish gsd-pi's own writes (expected) from external edits made by gsd-core
// (drift to import). gsd-core is oblivious to this file and ignores it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Current marker schema version. Bump on breaking format changes + migrate. */
export const COMPAT_MARKER_SCHEMA = 1;

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
  piVersion: string;
}

/** Marker returned when no marker exists yet (fresh project, first gsd-pi run). */
export const EMPTY_MARKER: CompatMarker = {
  schema: COMPAT_MARKER_SCHEMA,
  lastWriter: "gsd-pi",
  lastProjectedAt: "",
  projections: {},
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
  if (parsed.schema !== COMPAT_MARKER_SCHEMA) {
    // Future schema: refuse rather than guess. Re-running reconcile regenerates.
    quarantine(basePath, raw);
    return emptyMarker();
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

function quarantine(basePath: string, raw: string): void {
  const badPath = `${compatMarkerPath(basePath)}.bad-${Date.now()}`;
  try {
    mkdirSync(dirname(badPath), { recursive: true });
    writeFileSync(badPath, raw, "utf-8");
  } catch {
    // Best-effort: if we can't quarantine, leave the original in place — next
    // read will quarantine. Never throw out of marker I/O.
  }
}

function isValidMarker(x: unknown): x is CompatMarker {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m.lastWriter !== "gsd-pi") return false;
  if (typeof m.schema !== "number") return false;
  if (typeof m.lastProjectedAt !== "string") return false;
  if (typeof m.piVersion !== "string") return false;
  if (typeof m.projections !== "object" || m.projections === null) return false;
  for (const v of Object.values(m.projections as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) return false;
    const e = v as Record<string, unknown>;
    if (typeof e.sha !== "string") return false;
    if (!Array.isArray(e.entities) || !e.entities.every((s) => typeof s === "string")) return false;
  }
  return true;
}
