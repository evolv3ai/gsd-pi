// Project/App: gsd-pi
// File Purpose: Schema-2 compat marker tests — the `planning` field.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  readCompatMarker,
  writeCompatMarker,
  EMPTY_MARKER,
  COMPAT_MARKER_SCHEMA,
} from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];
function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-pm-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("schema version is 2", () => {
  assert.equal(COMPAT_MARKER_SCHEMA, 2);
});

test("EMPTY_MARKER has planning inactive with empty maps", () => {
  assert.deepEqual(EMPTY_MARKER.planning, {
    active: false,
    layout: null,
    projections: {},
    passthrough: {},
  });
});

test("writeCompatMarker then readCompatMarker round-trips planning field", () => {
  const base = makeTmpBase();
  const marker = {
    schema: 2,
    lastWriter: "gsd-pi" as const,
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases" as const,
      projections: {
        "ROADMAP.md": { sha: "abc", entities: ["M001"] },
      },
      passthrough: {
        "codebase/STACK.md": { sha: "def", entities: [] },
      },
    },
    piVersion: "1.4.0",
  };
  writeCompatMarker(base, marker);
  const read = readCompatMarker(base);
  assert.deepEqual(read.planning, marker.planning);
});

test("readCompatMarker promotes a schema-1 marker by defaulting planning inactive", () => {
  const base = makeTmpBase();
  // Hand-write a schema-1 marker (no planning field).
  const v1 = {
    schema: 1,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-01T00:00:00.000Z",
    projections: { "x.md": { sha: "1", entities: [] } },
    piVersion: "1.3.0",
  };
  writeFileSync(join(base, ".gsd", ".compat.json"), JSON.stringify(v1), "utf-8");

  const read = readCompatMarker(base);
  // Promotion: planning defaults inactive. (raw schema value preserved on read;
  // promotion is at read-time, a rewrite would emit schema 2.)
  assert.deepEqual(read.planning, { active: false, layout: null, projections: {}, passthrough: {} });
});

test("emptyMarker returns independent planning objects (no shared reference)", () => {
  // Mutating one empty-marker read must not pollute another.
  const base1 = makeTmpBase();
  const base2 = makeTmpBase();
  const m1 = readCompatMarker(base1);
  m1.planning!.projections["x"] = { sha: "1", entities: [] };
  const m2 = readCompatMarker(base2);
  assert.equal(m2.planning!.projections["x"], undefined);
});

test("readCompatMarker quarantines a marker with invalid planning field", () => {
  const base = makeTmpBase();
  const bad = {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {},
    planning: { active: "not-a-boolean" }, // invalid
    piVersion: "1.4.0",
  };
  writeFileSync(join(base, ".gsd", ".compat.json"), JSON.stringify(bad), "utf-8");
  const read = readCompatMarker(base);
  assert.deepEqual(read.planning, { active: false, layout: null, projections: {}, passthrough: {} });
});
