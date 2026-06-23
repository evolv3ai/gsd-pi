import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mapQuerySnapshot } from "./status-mapper.js";

describe("mapQuerySnapshot", () => {
  test("maps a full snapshot", () => {
    const snap = {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Bootstrap" },
        activeSlice:     { id: "S01",  title: "Parser" },
        activeTask:      { id: "T01",  title: "Types" },
        blockers: [],
        nextAction: "dispatch T01",
        progress: { milestones: { done: 0, total: 1 }, slices: { done: 0, total: 3 }, tasks: { done: 0, total: 7 } },
      },
      next: { action: "dispatch", unitId: "M001/S01/T01" },
      cost: { workers: [], total: 0.42 },
    };
    const status = mapQuerySnapshot(snap);
    assert.equal(status.phase, "executing");
    assert.deepEqual(status.activeMilestone, { id: "M001", title: "Bootstrap" });
    assert.deepEqual(status.activeTask, { id: "T01", title: "Types" });
    assert.equal(status.cost, 0.42);
    assert.equal(status.nextAction, "dispatch T01");
    assert.deepEqual(status.progress?.tasks, { done: 0, total: 7 });
  });

  test("defaults missing fields", () => {
    const status = mapQuerySnapshot({ state: { phase: "idle" } });
    assert.equal(status.phase, "idle");
    assert.equal(status.activeMilestone, null);
    assert.equal(status.activeSlice, null);
    assert.equal(status.activeTask, null);
    assert.equal(status.cost, 0);
    assert.equal(status.nextAction, null);
    assert.deepEqual(status.blockers, []);
    assert.equal(status.progress, null);
    assert.equal(status.sessionId, null);
  });

  test("non-object input becomes a safe empty status", () => {
    const status = mapQuerySnapshot(null);
    assert.equal(status.phase, "unknown");
  });
});
