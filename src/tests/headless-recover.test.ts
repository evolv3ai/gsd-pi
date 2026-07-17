// gsd-pi · headless recover wiring
//
// Regression test for the headless recover entrypoint introduced to make
// `gsd headless recover` available to non-TTY callers (CI, automation, the
// live-regression suite). The headless dispatcher previously had no
// `recover` case — the only path was the interactive slash-command
// (`/gsd recover`), which is gated behind a TTY check (src/cli.ts
// printNonTtyErrorAndExit) and rejected piped invocations.
//
// Public headless recovery must use the same retained-backup Import
// Application boundary as the interactive slash command. A few direct
// Markdown-importer tests remain as low-level compatibility characterization.
//
// The dispatcher branch itself (one if-block in headless.ts) is verified
// by `npm run build:core`; the behavior-level guarantees live here.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureDbOpen } from "../resources/extensions/gsd/bootstrap/dynamic-tools.ts";
import {
  isDbAvailable,
  closeDatabase,
  clearEngineHierarchy,
  transaction,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  getMilestone,
  insertMilestone,
  insertGateRow,
  _getAdapter,
} from "../resources/extensions/gsd/gsd-db.ts";
import { migrateHierarchyToDb } from "../resources/extensions/gsd/md-importer.ts";
import { invalidateStateCache } from "../resources/extensions/gsd/state.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../resources/extensions/gsd/legacy-import-preview-base.ts";
import { createLegacyImportPreview } from "../resources/extensions/gsd/legacy-import-preview.ts";
import { fingerprintLegacyImportCorpusTree } from "../resources/extensions/gsd/tests/helpers/legacy-import-corpus.ts";

const previousAgentDir = process.env.GSD_AGENT_DIR;
process.env.GSD_AGENT_DIR = join(tmpdir(), `gsd-headless-recover-missing-agent-${process.pid}`);
const { handleRecover: handleHeadlessRecover } = await import("../headless-recover.ts");
after(() => {
  if (previousAgentDir === undefined) delete process.env.GSD_AGENT_DIR;
  else process.env.GSD_AGENT_DIR = previousAgentDir;
});

function makeMarkdownFixture(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-headless-recover-"));
  const mDir = join(base, ".gsd", "milestones", "M001");
  const sDir = join(mDir, "slices", "S01");
  mkdirSync(join(sDir, "tasks"), { recursive: true });

  writeFileSync(
    join(mDir, "M001-CONTEXT.md"),
    "# M001: Recover Fixture\n\n## Purpose\nTest headless recover.\n",
  );
  writeFileSync(
    join(mDir, "M001-ROADMAP.md"),
    [
      "# M001: Recover Fixture",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First Slice** `risk:low` `depends:[]`",
      "  > Demo for S01",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(sDir, "S01-PLAN.md"),
    [
      "# S01: First Slice",
      "",
      "**Goal:** test",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: First Task** `est:5m`",
    ].join("\n"),
  );
  return base;
}

const CORPUS_ROOT = join(
  import.meta.dirname,
  "..",
  "resources",
  "extensions",
  "gsd",
  "tests",
  "__fixtures__",
  "legacy-import-corpus",
  "v1",
);

function makeCorpusFixture(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-headless-recover-corpus-"));
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source", ".gsd"), join(base, ".gsd"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  return base;
}

function recoverPreview(base: string) {
  return createLegacyImportPreview({
    roots: [
      {
        id: "project-phases",
        kind: "project",
        physical_path: join(base, ".gsd", "phases"),
        logical_path: ".gsd/phases",
        presence: "optional",
      },
      {
        id: "project-milestones",
        kind: "project",
        physical_path: join(base, ".gsd", "milestones"),
        logical_path: ".gsd/milestones",
        presence: "optional",
      },
    ],
  });
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

test("legacy Markdown importer populates hierarchy in a direct compatibility fixture", async (t) => {
  const base = makeMarkdownFixture();
  t.after(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    rmSync(base, { recursive: true, force: true });
  });

  const opened = await ensureDbOpen(base);
  assert.ok(opened, "ensureDbOpen should succeed when .gsd/ exists");
  assert.ok(isDbAvailable(), "DB should be open after ensureDbOpen");

  const counts = transaction(() => {
    clearEngineHierarchy();
    return migrateHierarchyToDb(base);
  });
  invalidateStateCache();

  assert.equal(counts.milestones, 1, "one milestone imported");
  assert.equal(counts.slices, 1, "one slice imported");
  assert.equal(counts.tasks, 1, "one task imported");

  const milestones = getAllMilestones();
  assert.equal(milestones.length, 1, "DB has the imported milestone");
  assert.equal(milestones[0]!.id, "M001");

  const slices = getMilestoneSlices("M001");
  assert.equal(slices.length, 1, "milestone has the imported slice");
  assert.equal(slices[0]!.id, "S01");
  assert.equal(slices[0]!.status, "pending");

  const tasks = getSliceTasks("M001", "S01");
  assert.equal(tasks.length, 1, "slice has the imported task");
  assert.equal(tasks[0]!.id, "T01");
});

test("legacy Markdown importer is stable across an explicit test-only reset", async (t) => {
  const base = makeMarkdownFixture();
  t.after(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    rmSync(base, { recursive: true, force: true });
  });

  await ensureDbOpen(base);

  const first = transaction(() => {
    clearEngineHierarchy();
    return migrateHierarchyToDb(base);
  });
  invalidateStateCache();

  const second = transaction(() => {
    clearEngineHierarchy();
    return migrateHierarchyToDb(base);
  });
  invalidateStateCache();

  assert.deepEqual(
    second,
    first,
    "an explicit test-only reset must reproduce identical importer counts",
  );
  assert.equal(getAllMilestones().length, 1, "DB has exactly one milestone after the second pass");
  assert.equal(getSliceTasks("M001", "S01").length, 1, "DB has exactly one task after the second pass");
});

test("test-only hierarchy clearing permits a subsequent legacy Markdown import", async (t) => {
  const base = makeMarkdownFixture();
  t.after(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    rmSync(base, { recursive: true, force: true });
  });

  await ensureDbOpen(base);

  transaction(() => {
    clearEngineHierarchy();
    return migrateHierarchyToDb(base);
  });
  invalidateStateCache();

  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });

  const recovered = transaction(() => {
    clearEngineHierarchy();
    return migrateHierarchyToDb(base);
  });
  invalidateStateCache();

  assert.deepEqual(recovered, { milestones: 1, slices: 1, tasks: 1 });
  assert.equal(getSliceTasks("M001", "S01").length, 1, "DB has the imported task after gate-backed recovery");
});

test("headless recover: verified-backup failure aborts before destructive work", async (t) => {
  const base = makeMarkdownFixture();
  const previousAllowDataLoss = process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
  const previousWrite = process.stderr.write;
  const stderr: string[] = [];
  t.after(() => {
    process.stderr.write = previousWrite;
    if (previousAllowDataLoss === undefined) delete process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
    else process.env.GSD_RECOVER_ALLOW_DATA_LOSS = previousAllowDataLoss;
    try { closeDatabase(); } catch { /* may not be open */ }
    rmSync(base, { recursive: true, force: true });
  });

  await ensureDbOpen(base);
  insertMilestone({ id: "M999", title: "Authoritative sentinel", status: "active" });
  process.env.GSD_RECOVER_ALLOW_DATA_LOSS = "1";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  writeFileSync(join(base, ".gsd", "backups"), "blocks backup directory creation");

  const result = await handleHeadlessRecover(base);

  assert.equal(result.exitCode, 1, "a gate failure is a recover failure");
  assert.match(stderr.join(""), /backups|exist|directory/i);
  assert.ok(getMilestone("M999"), "gate failure preserves authoritative DB rows");
  assert.equal(getMilestone("M001"), null, "gate failure does not import markdown rows");
});

test("headless recover: reports the drilled content-addressed backup used before recovery", async (t) => {
  const base = makeCorpusFixture();
  const previousAllowDataLoss = process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
  const previousWrite = process.stderr.write;
  const stderr: string[] = [];
  t.after(() => {
    process.stderr.write = previousWrite;
    if (previousAllowDataLoss === undefined) delete process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
    else process.env.GSD_RECOVER_ALLOW_DATA_LOSS = previousAllowDataLoss;
    try { closeDatabase(); } catch { /* may not be open */ }
    rmSync(base, { recursive: true, force: true });
  });

  await ensureDbOpen(base);
  insertMilestone({ id: "M999", title: "Authoritative sentinel", status: "active" });
  delete process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const result = await handleHeadlessRecover(base);

  assert.equal(result.exitCode, 0);
  assert.ok(getMilestone("M999"), "recovery preserves pre-existing authority after the gate");
  assert.ok(getMilestone("M001"), "recovery imports markdown after the gate");
  const backupsDirectory = join(base, ".gsd", "backups");
  const backupNames = readdirSync(backupsDirectory);
  assert.equal(backupNames.length, 1, "successful recovery publishes one backup without sidecars");
  assert.match(backupNames[0]!, /^pre-recover-[0-9a-f]{64}\.sqlite$/u);
  const backupPath = join(backupsDirectory, backupNames[0]!);
  assert.ok(stderr.join("").includes(backupPath), "success reports the drilled .sqlite backup path");
});

test("headless recover no longer requires a data-loss override for non-destructive Application", async (t) => {
  const base = makeCorpusFixture();
  const previousAllowDataLoss = process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
  t.after(() => {
    if (previousAllowDataLoss === undefined) delete process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
    else process.env.GSD_RECOVER_ALLOW_DATA_LOSS = previousAllowDataLoss;
    try { closeDatabase(); } catch { /* may not be open */ }
    rmSync(base, { recursive: true, force: true });
  });

  await ensureDbOpen(base);
  insertMilestone({ id: "M999", title: "Authoritative sentinel", status: "active" });
  delete process.env.GSD_RECOVER_ALLOW_DATA_LOSS;

  const result = await handleHeadlessRecover(base);

  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(join(base, ".gsd", "backups")), true);
  assert.ok(getMilestone("M999"), "non-destructive recover preserves authoritative DB rows");
  assert.ok(getMilestone("M001"), "non-destructive recover imports approved markdown rows");
});

test("headless recover uses the entrypoint-neutral retained-backup Import Application path", async (t) => {
  const base = makeCorpusFixture();
  const previousAllowDataLoss = process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
  const previousWrite = process.stderr.write;
  const stderr: string[] = [];
  t.after(() => {
    process.stderr.write = previousWrite;
    if (previousAllowDataLoss === undefined) delete process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
    else process.env.GSD_RECOVER_ALLOW_DATA_LOSS = previousAllowDataLoss;
    try { closeDatabase(); } catch { /* may not be open */ }
    rmSync(base, { recursive: true, force: true });
  });

  assert.equal(await ensureDbOpen(base), true);
  insertMilestone({ id: "M900", title: "Authoritative sentinel", status: "active" });
  const approvedBase = captureCurrentLegacyImportBaseSnapshot();
  const approvedPreview = recoverPreview(base);
  assert.equal(approvedPreview.preview.counts.unresolved, 0);
  const sourceBefore = fingerprintLegacyImportCorpusTree(join(base, ".gsd", "milestones"));
  delete process.env.GSD_RECOVER_ALLOW_DATA_LOSS;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const result = await handleHeadlessRecover(base);

  assert.equal(result.exitCode, 0);
  const db = _getAdapter()!;
  const operation = db.prepare(`SELECT * FROM workflow_operations
    WHERE operation_type = 'import.apply'`).get() as Record<string, unknown> | undefined;
  assert.ok(operation, "headless recover must commit through the public Import Application");
  assert.equal(operation.idempotency_key, `legacy-import/recover/${approvedPreview.preview.preview_id}`);
  assert.equal(operation.source_transport, "internal");
  assert.equal(operation.actor_type, "system");
  assert.equal(operation.actor_id, "gsd-recover");
  assert.equal(operation.trace_id, null);
  assert.equal(operation.turn_id, null);
  assert.equal(operation.expected_revision, approvedBase.authority.revision);
  assert.equal(operation.resulting_revision, approvedBase.authority.revision + 1);
  assert.equal(operation.expected_authority_epoch, approvedBase.authority.authority_epoch);
  assert.equal(operation.resulting_authority_epoch, approvedBase.authority.authority_epoch);
  assert.equal(operation.request_hash, approvedPreview.preview_hash);
  assert.ok(getMilestone("M900"), "headless recover must not clear canonical rows absent from the Preview");

  const application = db.prepare("SELECT * FROM workflow_import_applications").get() as Record<string, unknown>;
  assert.equal(application.operation_id, operation.operation_id);
  assert.equal(application.preview_id, approvedPreview.preview.preview_id);
  assert.equal(application.preview_hash, approvedPreview.preview_hash);
  assert.equal(application.base_project_revision, approvedBase.authority.revision);
  assert.equal(application.resulting_project_revision, approvedBase.authority.revision + 1);
  assert.equal(application.resulting_authority_epoch, approvedBase.authority.authority_epoch);
  assert.equal(application.backup_quick_check, "ok");
  assert.equal(existsSync(String(application.backup_ref)), true, "verified backup remains retained");
  assert.equal(statSync(String(application.backup_ref)).size, application.backup_byte_size);
  assert.equal(sha256(String(application.backup_ref)), application.backup_sha256);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_domain_events").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_outbox").get()?.count, 1);
  assert.ok(Number(db.prepare("SELECT COUNT(*) AS count FROM workflow_projection_work").get()?.count) > 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_recovery_actions").get()?.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_recovery_budgets").get()?.count, 0);
  assert.equal(fingerprintLegacyImportCorpusTree(join(base, ".gsd", "milestones")), sourceBefore);
  assert.ok(stderr.join("").includes(String(application.backup_ref)), "reported backup is the retained Application backup");
});
