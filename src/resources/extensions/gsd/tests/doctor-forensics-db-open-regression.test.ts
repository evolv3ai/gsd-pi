import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _getAdapter,
  closeDatabase,
  getHierarchyCompletionCounts,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { buildForensicReport } from "../forensics.ts";
import { handleDoctor } from "../commands-handlers.ts";
import { withCommandCwd } from "../commands/context.ts";

test("#5194 forensics opens DB before computing completion counts", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-forensics-db-open-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  mkdirSync(join(base, ".gsd"), { recursive: true });
  closeDatabase();

  const report = await buildForensicReport(base);
  assert.ok(report.dbCompletionCounts, "forensics should expose DB completion counts when .gsd exists");
  assert.equal(report.dbCompletionCounts?.milestonesTotal, 0);
  assert.equal(report.dbCompletionCounts?.slicesTotal, 0);
  assert.equal(report.dbCompletionCounts?.tasksTotal, 0);
});

test("#968 completion counts use fixed aggregate queries and canonical closed statuses", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-forensics-counts-"));
  const dbPath = join(base, "gsd.db");
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(dbPath);

  insertMilestone({ id: "M001", status: "complete" });
  insertMilestone({ id: "M002", status: "active" });
  insertMilestone({ id: "M003", status: "closed" });

  insertSlice({ milestoneId: "M001", id: "S01", status: "done" });
  insertSlice({ milestoneId: "M001", id: "S02", status: "pending" });
  insertSlice({ milestoneId: "M002", id: "S01", status: "skipped" });
  insertSlice({ milestoneId: "M003", id: "S01", status: "active" });

  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", status: "complete" });
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", status: "done" });
  insertTask({ milestoneId: "M001", sliceId: "S02", id: "T01", status: "skipped" });
  insertTask({ milestoneId: "M002", sliceId: "S01", id: "T01", status: "closed" });
  insertTask({ milestoneId: "M002", sliceId: "S01", id: "T02", status: "pending" });
  insertTask({ milestoneId: "M003", sliceId: "S01", id: "T01", status: "active" });

  const adapter = _getAdapter()!;
  const originalPrepare = adapter.prepare.bind(adapter);
  const preparedSql: string[] = [];
  adapter.prepare = (sql) => {
    preparedSql.push(sql);
    return originalPrepare(sql);
  };

  assert.deepEqual(getHierarchyCompletionCounts(), {
    milestones: 2,
    milestonesTotal: 3,
    slices: 2,
    slicesTotal: 4,
    tasks: 4,
    tasksTotal: 6,
  });

  assert.equal(preparedSql.length, 3);
  assert.ok(preparedSql.every((sql) => /COUNT\(\*\)/i.test(sql)));
  assert.doesNotMatch(preparedSql.join("\n"), /SELECT\s+\*/i);
});

test("#968 forensics completion counts do not re-query slices and tasks", () => {
  const source = readFileSync(join(process.cwd(), "src/resources/extensions/gsd/forensics.ts"), "utf-8");
  const start = source.indexOf("function getDbCompletionCounts()");
  const end = source.indexOf("// ─── Anomaly Detectors", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);

  assert.match(body, /getHierarchyCompletionCounts\(\)/);
  assert.doesNotMatch(body, /getAllMilestones|getMilestoneSlices|getSliceTasks/);
});

test("#5194 doctor command does not emit false db_unavailable when gsd.db exists", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-db-open-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "gsd.db"), "");
  closeDatabase();

  const notifications: string[] = [];
  const ctx = { ui: { notify: (msg: string) => notifications.push(msg) } } as any;
  const pi = {} as any;

  await withCommandCwd(base, async () => {
    await handleDoctor("--json", ctx, pi);
  });

  const jsonReport = notifications.find((entry) => entry.trim().startsWith("{"));
  assert.ok(jsonReport, "doctor --json should emit a JSON report");
  assert.doesNotMatch(
    jsonReport!,
    /"code"\s*:\s*"db_unavailable"/,
    "doctor should not report db_unavailable when it can open project DB",
  );
});
