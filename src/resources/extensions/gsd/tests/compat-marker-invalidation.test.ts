// Project/App: gsd-pi
// File Purpose: Verifies that projection writes update .gsd/.compat.json.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { renderRoadmapFromDb } from "../markdown-renderer.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";
import { readCompatMarker } from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-inv-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "T", status: "pending", risk: "low", depends: [] });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("renderRoadmapFromDb writes a compat marker entry for the roadmap file", async () => {
  const base = makeTmp();
  await renderRoadmapFromDb(base, "M001");
  const marker = readCompatMarker(base);
  const rels = Object.keys(marker.projections);
  assert.ok(
    rels.some((r) => r.includes("M001") && r.endsWith("ROADMAP.md")),
    `expected roadmap entry, got ${JSON.stringify(rels)}`,
  );
  // Marker should record gsd-pi as last writer and a non-empty timestamp.
  assert.equal(marker.lastWriter, "gsd-pi");
  assert.ok(marker.lastProjectedAt.length > 0, "expected non-empty lastProjectedAt");
});

test("re-rendering the same file updates the marker entry (not duplicates)", async () => {
  const base = makeTmp();
  await renderRoadmapFromDb(base, "M001");
  await renderRoadmapFromDb(base, "M001");
  const marker = readCompatMarker(base);
  const roadmapEntries = Object.keys(marker.projections).filter((r) => r.endsWith("ROADMAP.md"));
  assert.equal(roadmapEntries.length, 1, "expected exactly one roadmap entry after re-render");
});
