import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import type { BridgeStatus } from "../gsd/status-mapper.js";
import { computeSync, normalizeTitle, matchIndex, type MarkerUpdate } from "./marker-map.js";
import { correlate } from "./correlate.js";

const here = dirname(fileURLToPath(import.meta.url));
const plan = parsePlanf3Html(readFileSync(join(here, "..", "fixtures", "minimal-plan.html"), "utf8"));

// M4: title resolution moved to correlate.ts; these tests exercise the same
// M3 behavior through the composed path with an empty (legacy) mapping.
const run = (status: BridgeStatus, milestoneId: string) =>
  computeSync(plan, status, milestoneId, correlate(plan, [], status));

const BASE: BridgeStatus = {
  phase: "executing",
  activeMilestone: null,
  lastCompletedMilestone: null,
  activeSlice: null,
  activeTask: null,
  progress: null,
  cost: 0,
  nextAction: null,
  blockers: [],
  sessionId: null,
};

function byOcc(updates: MarkerUpdate[]): Map<number, MarkerUpdate> {
  return new Map(updates.map((u) => [u.occurrence, u]));
}

describe("normalizeTitle", () => {
  test("strips phase prefix, punctuation, case, whitespace", () => {
    assert.equal(normalizeTitle("Phase 2: Wire-up"), "wire up");
    assert.equal(normalizeTitle("1. Scaffolding"), "scaffolding");
    assert.equal(normalizeTitle("  FOO,  bar!! "), "foo bar");
  });
});

describe("matchIndex", () => {
  const titles = ["Phase 1: Setup", "Phase 2: Wire-up"];
  test("exact normalized equality", () => {
    assert.equal(matchIndex("Setup", titles), 0);
    assert.equal(matchIndex("wire up", titles), 1);
  });
  test("unique substring containment (either direction)", () => {
    assert.equal(matchIndex("wire", titles), 1);
  });
  test("ambiguous containment -> null", () => {
    // "up" is a substring of both "setup" and "wire up"
    assert.equal(matchIndex("Up", titles), null);
  });
  test("no match -> null", () => {
    assert.equal(matchIndex("Deployment", titles), null);
  });
});

describe("computeSync — completion sweep (rule 1)", () => {
  const status: BridgeStatus = { ...BASE, phase: "idle", lastCompletedMilestone: { id: "M042", title: "Minimal Plan" } };

  test("every marker below done rises to [x]; already-[x] untouched; [f] upgraded", () => {
    const r = run(status, "M042");
    assert.equal(r.observable, true);
    assert.equal(r.completed, true);
    assert.equal(r.expectedMarkerCount, 9);
    const m = byOcc(r.updates);
    // occ 1 is already [x] — no update for it
    assert.deepEqual([...m.keys()].sort((a, b) => a - b), [0, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(m.get(0)?.from, "[wip]");
    assert.equal(m.get(5)?.from, "[f]"); // failed -> done: completion means the retry succeeded
    for (const u of r.updates) assert.equal(u.to, "[x]");
    // validation markers carry from:null (parser exposes no status for them)
    assert.equal(m.get(7)?.from, null);
    assert.equal(m.get(8)?.from, null);
  });

  test("wrong milestone id -> not observable, zero updates", () => {
    const r = run(status, "M999");
    assert.equal(r.observable, false);
    assert.deepEqual(r.updates, []);
  });
});

describe("computeSync — active rules (2-4)", () => {
  const active = (over: Partial<BridgeStatus>): BridgeStatus => ({
    ...BASE,
    activeMilestone: { id: "M042", title: "Minimal Plan" },
    ...over,
  });

  test("activeSlice matches phase heading -> phase marker [wip]", () => {
    const r = run(active({ activeSlice: { id: "S2", title: "Wire-up" } }), "M042");
    assert.equal(r.observable, true);
    const m = byOcc(r.updates);
    assert.deepEqual(m.get(4), { occurrence: 4, from: "[]", to: "[wip]", label: "Phase 2: Wire-up" });
    assert.deepEqual(r.unmatched, []);
  });

  test("monotonic: phase already [wip] does not re-update (idempotent)", () => {
    const r = run(active({ activeSlice: { id: "S1", title: "Setup" } }), "M042");
    assert.deepEqual(r.updates, []);
  });

  test("monotonic: [x] item never demoted to [wip]", () => {
    const r = run(active({ activeTask: { id: "T1", title: "Create the dir." } }), "M042");
    assert.deepEqual(r.updates, []);
  });

  test("monotonic: [f] item never demoted to [wip]", () => {
    const r = run(active({ activeTask: { id: "T5", title: "First attempt failed." } }), "M042");
    assert.deepEqual(r.updates, []);
  });

  test("blockers -> [f] on the matched unit only", () => {
    const r = run(
      active({ activeSlice: { id: "S2", title: "Wire-up" }, blockers: [{ reason: "stuck" }] }),
      "M042",
    );
    const m = byOcc(r.updates);
    assert.deepEqual([...m.keys()], [4]);
    assert.equal(m.get(4)?.to, "[f]");
  });

  test("blockers upgrade a [wip] phase to [f] (rank 2 > 1)", () => {
    const r = run(
      active({ activeSlice: { id: "S1", title: "Setup" }, blockers: ["x"] }),
      "M042",
    );
    assert.deepEqual(byOcc(r.updates).get(0), { occurrence: 0, from: "[wip]", to: "[f]", label: "Phase 1: Setup" });
  });

  test("activeTask matches checklist item text -> item marker", () => {
    const r = run(active({ activeTask: { id: "T6", title: "Retry with mocked spawn." } }), "M042");
    assert.deepEqual(byOcc(r.updates).get(6), { occurrence: 6, from: "[]", to: "[wip]", label: "Retry with mocked spawn." });
  });

  test("activeTask falls back to h4 heading -> containing phase's marker", () => {
    // "Scaffolding" matches no item text but matches h4 "1. Scaffolding" in phase 1;
    // phase 1 is [wip], so only a blocker ([f], rank 2) raises it.
    const r = run(active({ activeTask: { id: "T0", title: "Scaffolding" }, blockers: ["b"] }), "M042");
    assert.deepEqual(byOcc(r.updates).get(0), { occurrence: 0, from: "[wip]", to: "[f]", label: "Phase 1: Setup" });
  });

  test("slice and task-fallback landing on the same phase dedupe to one update", () => {
    const r = run(
      active({
        activeSlice: { id: "S1", title: "Setup" },
        activeTask: { id: "T0", title: "Scaffolding" },
        blockers: ["b"],
      }),
      "M042",
    );
    assert.equal(r.updates.length, 1);
    assert.equal(r.updates[0].occurrence, 0);
  });

  test("unmatched refs change nothing and are reported", () => {
    const r = run(
      active({ activeSlice: { id: "S9", title: "Deployment" }, activeTask: { id: "T9", title: "Ship it" }, blockers: ["b"] }),
      "M042",
    );
    assert.deepEqual(r.updates, []);
    assert.deepEqual(r.unmatched, ["Deployment", "Ship it"]);
  });

  test("foreign activeMilestone -> rules 3-4 gated off, not observable", () => {
    const r = run(
      { ...BASE, activeMilestone: { id: "M777", title: "Other" }, activeSlice: { id: "S", title: "Setup" } },
      "M042",
    );
    assert.equal(r.observable, false);
    assert.deepEqual(r.updates, []);
  });

  test("lastCompleted foreign + active ours -> rules 3-4 still apply (no sweep)", () => {
    const r = run(
      active({ lastCompletedMilestone: { id: "M001", title: "Older" }, activeSlice: { id: "S2", title: "Wire-up" } }),
      "M042",
    );
    assert.equal(r.completed, false);
    assert.deepEqual([...byOcc(r.updates).keys()], [4]);
  });
});
