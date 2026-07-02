// batch-task-query.test.ts
// Verifies getTasksBySliceIds batches tasks correctly and matches the per-slice
// getSliceTasks path (guards the projection N+1 fix).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getSliceTasks,
  getTasksBySliceIds,
} from "../gsd-db.ts";

function withDb(fn: () => void): void {
  const base = mkdtempSync(join(tmpdir(), "gsd-batch-task-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    fn();
  } finally {
    try { closeDatabase(); } catch {}
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  }
}

function seed(): void {
  insertMilestone({ id: "M001", title: "M1", status: "active" });
  insertMilestone({ id: "M002", title: "M2", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "S1", status: "active", risk: "low", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M001", title: "S2", status: "pending", risk: "low", depends: [] });
  insertSlice({ id: "S01", milestoneId: "M002", title: "S1", status: "active", risk: "low", depends: [] });
  // M001/S01 has two tasks; M001/S02 has one; M002/S01 has none.
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "second", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "first", status: "complete" });
  insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "only", status: "pending" });
}

const key = (m: string, s: string) => `${m}\0${s}`;

test("getTasksBySliceIds buckets tasks per (milestone, slice)", () => {
  withDb(() => {
    seed();
    const map = getTasksBySliceIds([
      { milestoneId: "M001", sliceId: "S01" },
      { milestoneId: "M001", sliceId: "S02" },
      { milestoneId: "M002", sliceId: "S01" },
    ]);
    assert.equal(map.get(key("M001", "S01"))?.length, 2);
    assert.equal(map.get(key("M001", "S02"))?.length, 1);
    // A slice with no tasks is absent (caller falls back to []).
    assert.equal(map.has(key("M002", "S01")), false);
  });
});

test("getTasksBySliceIds preserves ORDER BY sequence, id within a bucket", () => {
  withDb(() => {
    seed();
    const bucket = getTasksBySliceIds([{ milestoneId: "M001", sliceId: "S01" }]).get(key("M001", "S01"));
    // Insertion order was T02 then T01; ordering is by sequence then id, so T01 first.
    assert.deepEqual(bucket?.map((t) => t.id), ["T01", "T02"]);
  });
});

test("getTasksBySliceIds equals getSliceTasks for a single slice", () => {
  withDb(() => {
    seed();
    const batched = getTasksBySliceIds([{ milestoneId: "M001", sliceId: "S01" }]).get(key("M001", "S01"));
    const direct = getSliceTasks("M001", "S01");
    assert.deepEqual(batched, direct);
  });
});

test("getTasksBySliceIds returns an empty map for empty input", () => {
  withDb(() => {
    seed();
    assert.equal(getTasksBySliceIds([]).size, 0);
  });
});
