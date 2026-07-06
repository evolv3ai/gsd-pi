import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDoctorHistory, runGSDDoctor, type DoctorHistoryEntry } from "../doctor.ts";

test("doctor.ts preserves readDoctorHistory public API and records doctor runs", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-history-api-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });

  t.after(() => rmSync(base, { recursive: true, force: true }));

  const report = await runGSDDoctor(base, { fix: false });
  const history: DoctorHistoryEntry[] = await readDoctorHistory(base, 1);

  assert.equal(history.length, 1);
  assert.equal(history[0].ok, report.ok);
  assert.equal(history[0].errors, report.issues.filter(issue => issue.severity === "error").length);
  assert.equal(history[0].warnings, report.issues.filter(issue => issue.severity === "warning").length);
  assert.equal(history[0].fixes, 0);
  assert.ok(Array.isArray(history[0].codes));
  assert.equal(typeof history[0].summary, "string");
});
