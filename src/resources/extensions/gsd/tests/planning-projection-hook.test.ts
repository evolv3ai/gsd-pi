// Project/App: gsd-pi
// File Purpose: Verifies renderAllFromDb projects to .planning/ when active.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { renderAllFromDb } from "../markdown-renderer.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";
import { writeCompatMarker, readCompatMarker } from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-pph-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "T", status: "pending",
    risk: "low", depends: [], demo: "", sequence: 1,
  });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("renderAllFromDb projects to .planning/ when marker.planning.active", async () => {
  const base = makeTmp();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  await renderAllFromDb(base);
  assert.ok(
    existsSync(join(base, ".planning", "ROADMAP.md")),
    ".planning/ROADMAP.md should be projected",
  );
});

test("renderAllFromDb does NOT project to .planning/ when marker.planning inactive", async () => {
  const base = makeTmp();
  // Default marker: planning inactive.
  await renderAllFromDb(base);
  assert.ok(
    !existsSync(join(base, ".planning")),
    ".planning/ should not be created when inactive",
  );
});

test("renderAllFromDb records planning SHAs into marker.planning.projections", async () => {
  // Regression test for COMMENT:3449128453: writePlanningDirectory wrote files
  // but never updated marker.planning.projections, so the reconcile detector
  // always saw an empty baseline and never reported drift.
  const base = makeTmp();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  await renderAllFromDb(base);

  const marker = readCompatMarker(base);
  const planningKeys = Object.keys(marker.planning?.projections ?? {});
  assert.ok(planningKeys.length > 0, "marker.planning.projections must be non-empty after projection");

  // Every recorded entry must have a non-empty sha and an entities array.
  for (const [rel, entry] of Object.entries(marker.planning!.projections)) {
    assert.ok(typeof entry.sha === "string" && entry.sha.length > 0, `SHA missing for ${rel}`);
    assert.ok(Array.isArray(entry.entities), `entities must be an array for ${rel}`);
  }

  // ROADMAP.md must be among the recorded SHAs.
  assert.ok(
    planningKeys.some((k) => k === "ROADMAP.md"),
    `expected ROADMAP.md in projections, got ${JSON.stringify(planningKeys)}`,
  );
});

test("renderAllFromDb planning SHA baseline survives a subsequent readCompatMarker", async () => {
  // Regression test for COMMENT:3449128459: after renderAllFromDb the marker
  // must durably contain planning SHAs so a fresh read (e.g. handleSync's
  // marker stamp) does not clobber them.
  const base = makeTmp();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  await renderAllFromDb(base);

  // Simulate handleSync's marker stamp: read → mutate timestamps → write back.
  const m = readCompatMarker(base);
  m.lastWriter = "gsd-pi";
  m.lastProjectedAt = new Date().toISOString();
  const { writeCompatMarker: wm } = await import("../compat/compat-marker.ts");
  wm(base, m);

  // Planning SHAs must still be present after the stamp.
  const after = readCompatMarker(base);
  assert.ok(
    Object.keys(after.planning?.projections ?? {}).length > 0,
    "planning SHAs must survive a subsequent readCompatMarker + writeCompatMarker cycle",
  );
});
