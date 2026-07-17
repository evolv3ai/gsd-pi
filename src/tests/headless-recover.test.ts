// gsd-pi · headless recover wiring
//
// Regression test for the headless recover entrypoint introduced to make
// `gsd headless recover` available to non-TTY callers (CI, automation, the
// live-regression suite). The headless dispatcher previously had no
// `recover` case — the only path was the interactive slash-command
// (`/gsd recover`), which is gated behind a TTY check (src/cli.ts
// printNonTtyErrorAndExit) and rejected piped invocations.
//
// The headless wiring composes ensureDbOpen + clearEngineHierarchy +
// migrateHierarchyToDb + invalidateStateCache. This test exercises that
// pipeline against a markdown-only fixture and verifies that:
//   1. recovery succeeds against a fixture with only on-disk markdown,
//   2. the DB is populated with the expected milestone/slice/task rows,
//   3. running recovery a second time on an already-populated fixture is
//      idempotent (the `clearEngineHierarchy` step makes this safe).
//
// The dispatcher branch itself (one if-block in headless.ts) is verified
// by `npm run build:core`; the behavior-level guarantees live here.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
} from "../resources/extensions/gsd/gsd-db.ts";
import { migrateHierarchyToDb } from "../resources/extensions/gsd/md-importer.ts";
import { invalidateStateCache } from "../resources/extensions/gsd/state.ts";

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

test("headless recover: imports markdown hierarchy into authoritative DB", async (t) => {
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

test("headless recover: idempotent when run twice on the same fixture", async (t) => {
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
    "second recovery must produce identical counts (clear-then-import is idempotent)",
  );
  assert.equal(getAllMilestones().length, 1, "DB has exactly one milestone after the second pass");
  assert.equal(getSliceTasks("M001", "S01").length, 1, "DB has exactly one task after the second pass");
});

test("headless recover: clears gate rows before rebuilding hierarchy", async (t) => {
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

  const result = await handleHeadlessRecover(base);

  assert.equal(result.exitCode, 0);
  assert.equal(getMilestone("M999"), null, "recovery clears the old hierarchy only after the gate");
  assert.ok(getMilestone("M001"), "recovery imports markdown after the gate");
  const backupsDirectory = join(base, ".gsd", "backups");
  const backupNames = readdirSync(backupsDirectory);
  assert.equal(backupNames.length, 1, "successful recovery publishes one backup without sidecars");
  assert.match(backupNames[0]!, /^pre-recover-[0-9a-f]{64}\.sqlite$/u);
  const backupPath = join(backupsDirectory, backupNames[0]!);
  assert.ok(stderr.join("").includes(backupPath), "success reports the drilled .sqlite backup path");
});

test("headless recover: data-loss refusal happens before the verified-backup gate", async (t) => {
  const base = makeMarkdownFixture();
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

  assert.equal(result.exitCode, 1);
  assert.equal(
    existsSync(join(base, ".gsd", "backups")),
    false,
    "data-loss refusal short-circuits before backup preparation",
  );
  assert.ok(getMilestone("M999"), "refusal preserves authoritative DB rows");
  assert.equal(getMilestone("M001"), null, "refusal does not import markdown rows");
});
