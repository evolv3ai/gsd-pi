// Project/App: gsd-pi
// File Purpose: Proves DB-to-Markdown rendering never adopts an inactive planning tree.

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { readCompatMarker, writeCompatMarker } from "../compat/compat-marker.ts";
import {
  _getAdapter,
  closeDatabase,
  getMilestone,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";

const PLANNING_FIXTURE = fileURLToPath(
  new URL("./__fixtures__/round-trip/planning-flat-phases/.planning", import.meta.url),
);

interface CanonicalSnapshot {
  base: ReturnType<typeof captureCurrentLegacyImportBaseSnapshot>;
  lineage: Record<string, unknown>;
}

function makeWorkspace(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-render-authority-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function canonicalSnapshot(): CanonicalSnapshot {
  const database = _getAdapter();
  assert.ok(database);
  const lineage = database.prepare(`
    SELECT
      (SELECT count(*) FROM workflow_operations) AS operations,
      (SELECT count(*) FROM workflow_import_applications) AS applications,
      (SELECT count(*) FROM workflow_domain_events) AS events,
      (SELECT count(*) FROM workflow_outbox) AS outbox,
      (SELECT count(*) FROM workflow_projection_work) AS projections,
      total_changes() AS total_changes
  `).get() as Record<string, unknown>;
  return {
    base: captureCurrentLegacyImportBaseSnapshot(),
    lineage,
  };
}

function treeSnapshot(root: string, relative = ""): string[] {
  const entries: string[] = [];
  const directory = join(root, relative);
  const directoryEntries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of directoryEntries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (/^gsd\.db(?:-(?:wal|shm|journal))?$/.test(entry.name)) continue;
    if (entry.isDirectory()) {
      entries.push(`${child}/`);
      entries.push(...treeSnapshot(root, child));
      continue;
    }
    entries.push(`${child}:${readFileSync(join(root, child)).toString("base64")}`);
  }
  return entries;
}

function markerBytes(base: string): Buffer | null {
  const path = join(base, ".gsd", ".compat.json");
  return existsSync(path) ? readFileSync(path) : null;
}

test("renderAllFromDb does not adopt an inactive planning-only tree", async (t) => {
  const base = makeWorkspace(t);
  const seedResult = await renderAllFromDb(base);
  assert.deepEqual(seedResult.errors, [], "empty DB projection seed succeeds");
  cpSync(PLANNING_FIXTURE, join(base, ".planning"), { recursive: true });

  const planningBefore = treeSnapshot(join(base, ".planning"));
  const projectionBefore = treeSnapshot(join(base, ".gsd"));
  const markerBefore = markerBytes(base);
  const canonicalBefore = canonicalSnapshot();

  const result = await renderAllFromDb(base);

  assert.equal(getMilestone("M001"), null, "render must not adopt a Markdown-only milestone");
  assert.equal(readCompatMarker(base).planning?.active, false, "render must not activate planning compatibility");
  assert.equal(existsSync(join(base, ".gsd", "phases")), false, "render must not materialize planning hierarchy");
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false, "render must not materialize legacy hierarchy");
  assert.deepEqual(canonicalSnapshot(), canonicalBefore, "render must leave canonical authority and lineage exact");
  assert.deepEqual(treeSnapshot(join(base, ".planning")), planningBefore, "render must leave planning bytes exact");
  assert.deepEqual(
    treeSnapshot(join(base, ".gsd")),
    projectionBefore,
    "empty-DB render leaves the complete non-database .gsd tree exact, including DECISIONS",
  );
  assert.deepEqual(markerBytes(base), markerBefore, "inactive render leaves marker bytes exact");
  assert.deepEqual(result.errors, []);
});

test("renderAllFromDb still projects DB authority when planning compatibility is explicitly active", async (t) => {
  const base = makeWorkspace(t);
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Build tooling",
    status: "pending",
    risk: "low",
    depends: [],
    sequence: 1,
  });
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {},
      passthrough: {},
    },
    piVersion: "test",
  });

  const result = await renderAllFromDb(base);

  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(join(base, ".planning", "ROADMAP.md")), true);
  assert.match(readFileSync(join(base, ".planning", "ROADMAP.md"), "utf8"), /Build tooling/);
  assert.ok(readCompatMarker(base).planning?.projections["ROADMAP.md"]);
});
