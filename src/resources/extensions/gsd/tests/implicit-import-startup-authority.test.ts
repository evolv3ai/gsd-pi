// Project/App: gsd-pi
// File Purpose: Proves startup and layout compatibility paths never import Markdown into canonical authority.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  openProjectDbIfPresent,
  reconcileProjectMilestonesFromDisk,
} from "../auto-start.ts";
import { migrateToFlatPhase } from "../flat-phase-migration.ts";
import {
  _getAdapter,
  closeDatabase,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import { fingerprintLegacyImportCorpusTree } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = join(
  import.meta.dirname,
  "__fixtures__",
  "legacy-import-corpus",
  "v1",
  "gsd-nested",
  "source",
  ".gsd",
);
const SNAPSHOT_TABLES = [
  "project_authority",
  "milestones",
  "slices",
  "tasks",
  "slice_dependencies",
  "requirements",
  "decisions",
  "memories",
  "artifacts",
  "assessments",
  "workflow_item_lifecycles",
  "workflow_execution_attempts",
  "workflow_attempt_results",
  "workflow_kernel_checkpoints",
  "workflow_operations",
  "workflow_import_applications",
  "workflow_domain_events",
  "workflow_outbox",
  "workflow_projection_work",
  "workflow_recovery_actions",
  "workflow_recovery_budgets",
] as const;
const temporaryDirectories = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function createMarkdownOnlyProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-implicit-import-authority-"));
  temporaryDirectories.add(base);
  cpSync(CORPUS_ROOT, join(base, ".gsd"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  return base;
}

function durableSnapshot(): Record<string, unknown> {
  return Object.fromEntries(SNAPSHOT_TABLES.map((table) => [
    table,
    db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function totalChanges(): number {
  return Number(db().prepare("SELECT total_changes() AS count").get()?.["count"]);
}

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

test("startup database open and derive ignore markdown-only hierarchy without changing authority", async () => {
  const base = createMarkdownOnlyProject();
  const databasePath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(databasePath), true);
  const beforeOpen = durableSnapshot();
  closeDatabase();

  await openProjectDbIfPresent(base);

  assert.equal(isDbAvailable(), true);
  assert.deepEqual(durableSnapshot(), beforeOpen);
  assert.equal(totalChanges(), 0, "opening an existing database performs no authority write");
  const beforeDerive = durableSnapshot();
  const changesBeforeDerive = totalChanges();
  invalidateStateCache();

  const state = await deriveStateFromDb(base);

  assert.equal(state.registry.length, 0);
  assert.equal(state.activeMilestone, null);
  assert.equal(state.phase, "pre-planning");
  assert.deepEqual(durableSnapshot(), beforeDerive);
  assert.equal(totalChanges(), changesBeforeDerive);
});

test("PROJECT.md startup reconciliation cannot create canonical milestone rows", () => {
  const base = createMarkdownOnlyProject();
  writeFileSync(
    join(base, ".gsd", "PROJECT.md"),
    "# Project\n\n## Milestone Sequence\n- [ ] M010: Disk-only milestone - Must remain projection-only\n",
    "utf8",
  );
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const before = durableSnapshot();
  const changesBefore = totalChanges();

  const inserted = reconcileProjectMilestonesFromDisk(base);

  assert.equal(inserted, 0);
  assert.deepEqual(durableSnapshot(), before);
  assert.equal(totalChanges(), changesBefore);
});

test("flat-phase layout migration cannot ingest markdown-only hierarchy into an empty database", async () => {
  const base = createMarkdownOnlyProject();
  const milestonesPath = join(base, ".gsd", "milestones");
  const sourceBefore = fingerprintLegacyImportCorpusTree(milestonesPath);
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const before = durableSnapshot();
  const changesBefore = totalChanges();

  await assert.rejects(
    () => migrateToFlatPhase(base),
    /Recommended: run `\/gsd recover --confirm`/,
  );

  assert.deepEqual(durableSnapshot(), before);
  assert.equal(totalChanges(), changesBefore);
  assert.equal(existsSync(milestonesPath), true, "projection remains available for explicit import");
  assert.equal(fingerprintLegacyImportCorpusTree(milestonesPath), sourceBefore);
  assert.equal(existsSync(join(base, ".gsd", "phases")), false);
  assert.equal(existsSync(join(base, ".gsd-backups")), false);
});
