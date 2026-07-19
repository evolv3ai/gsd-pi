import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ParsedPlan } from "../parser/types.js";
import type { BridgeStatus } from "../gsd/status-mapper.js";
import { correlate, mappingViewOf, type MappedPhase } from "./correlate.js";

function makePlan(phases: { title: string; tasks: { title: string; items: string[] }[] }[]): ParsedPlan {
  return {
    title: "T", tagline: null,
    metadata: { created: null, modified: [], commits: [], agentName: null, sessionId: null, backRefs: [], forwardRefs: [] },
    purpose: "", problem: "", solution: "", existingFiles: [], newFiles: [],
    phases: phases.map((p) => ({
      title: p.title, status: "todo", tier: null, description: "",
      tasks: p.tasks.map((t) => ({
        title: t.title, tier: null,
        checklist: t.items.map((text) => ({ status: "todo" as const, text, command: null })),
      })),
    })),
    validationCommands: [], notes: "", amendments: [], openDecisions: [], modelPolicy: {}, integrations: [],
  };
}

const PLAN = makePlan([
  { title: "Phase 1: Alpha", tasks: [{ title: "1. First task", items: ["Do the thing.", "Check the thing."] }] },
  { title: "Phase 2: Beta", tasks: [{ title: "2. Second task", items: ["Ship it now."] }] },
]);

const MAPPING: MappedPhase[] = [
  { title: "Phase 1: Alpha", pf3Id: "PF3-P1", gsdSlice: null, tasks: [{ title: "1. First task", pf3Id: "PF3-P1-T1", gsdTask: null }] },
  { title: "Phase 2: Beta", pf3Id: "PF3-P2", gsdSlice: null, tasks: [{ title: "2. Second task", pf3Id: "PF3-P2-T1", gsdTask: null }] },
];

const BASE: BridgeStatus = {
  phase: "executing", activeMilestone: { id: "M1", title: "T" }, lastCompletedMilestone: null,
  activeSlice: null, activeTask: null, progress: null, cost: 0, nextAction: null, blockers: [], sessionId: null,
};

function withSlice(id: string, title: string, over: Partial<BridgeStatus> = {}): BridgeStatus {
  return { ...BASE, activeSlice: { id, title }, ...over };
}

function bound(gsdSlice: string | null, gsdTask: string | null = null): MappedPhase[] {
  return MAPPING.map((p, i) => ({
    ...p,
    gsdSlice: i === 1 ? gsdSlice : p.gsdSlice,
    tasks: p.tasks.map((t) => (i === 1 ? { ...t, gsdTask } : t)),
  }));
}

describe("correlate — slice ladder", () => {
  test("rung 1: persisted binding wins outright, nothing re-persisted", () => {
    const r = correlate(PLAN, bound("S77"), withSlice("S77", "Totally Unrelated Title"));
    assert.equal(r.slicePhaseIndex, 1);
    assert.equal(r.newSliceBinding, null);
    assert.deepEqual(r.unmatched, []);
  });

  test("rung 1 beats rung 2: stored binding outranks a conflicting tag", () => {
    const r = correlate(PLAN, bound("S77"), withSlice("S77", "Something [PF3-P1]"));
    assert.equal(r.slicePhaseIndex, 1); // binding says phase 2; tag says phase 1; binding wins
  });

  test("rung 2: unique PF3 tag resolves and binds", () => {
    const r = correlate(PLAN, MAPPING, withSlice("S5", "Invented Slice Name [PF3-P2]"));
    assert.equal(r.slicePhaseIndex, 1);
    assert.deepEqual(r.newSliceBinding, { phaseIndex: 1, gsdSlice: "S5" });
  });

  test("rung 2: a task tag on a slice still names its phase", () => {
    const r = correlate(PLAN, MAPPING, withSlice("S5", "Whatever [PF3-P2-T1]"));
    assert.equal(r.slicePhaseIndex, 1);
  });

  test("rung 2: two distinct tags fall through to title rules", () => {
    const r = correlate(PLAN, MAPPING, withSlice("S5", "merge [PF3-P1] [PF3-P2] Alpha"));
    assert.equal(r.slicePhaseIndex, 0); // resolved by rung 3 title match on "Alpha"
  });

  test("rung 3: M3 title rules resolve and now also bind", () => {
    const r = correlate(PLAN, MAPPING, withSlice("S5", "Beta"));
    assert.equal(r.slicePhaseIndex, 1);
    assert.deepEqual(r.newSliceBinding, { phaseIndex: 1, gsdSlice: "S5" });
  });

  test("rung 4: singleton ordinal fires only on exactly 1 phase x 1 slice", () => {
    const single = makePlan([{ title: "Phase 1: Only", tasks: [] }]);
    const oneByOne = withSlice("S1", "Invented Name", {
      progress: { milestones: { done: 0, total: 1 }, slices: { done: 0, total: 1 }, tasks: { done: 0, total: 2 } },
    });
    const r = correlate(single, [{ title: "Phase 1: Only", pf3Id: "PF3-P1", gsdSlice: null, tasks: [] }], oneByOne);
    assert.equal(r.slicePhaseIndex, 0);
    assert.deepEqual(r.newSliceBinding, { phaseIndex: 0, gsdSlice: "S1" });
  });

  test("rung 4 does NOT fire with 2 plan phases", () => {
    const r = correlate(PLAN, MAPPING, withSlice("S1", "Invented Name", {
      progress: { milestones: { done: 0, total: 1 }, slices: { done: 0, total: 1 }, tasks: { done: 0, total: 2 } },
    }));
    assert.equal(r.slicePhaseIndex, null);
    assert.deepEqual(r.unmatched, ["Invented Name"]);
  });

  test("rung 4 does NOT fire when the milestone reports 2 slices", () => {
    const single = makePlan([{ title: "Phase 1: Only", tasks: [] }]);
    const r = correlate(single, [{ title: "Phase 1: Only", pf3Id: "PF3-P1", gsdSlice: null, tasks: [] }],
      withSlice("S1", "Invented Name", {
        progress: { milestones: { done: 0, total: 1 }, slices: { done: 0, total: 2 }, tasks: { done: 0, total: 2 } },
      }));
    assert.equal(r.slicePhaseIndex, null);
  });

  test("rung 5: unmatched — nothing painted, title reported", () => {
    const r = correlate(PLAN, MAPPING, withSlice("S9", "Deployment"));
    assert.equal(r.slicePhaseIndex, null);
    assert.deepEqual(r.unmatched, ["Deployment"]);
    assert.equal(r.newSliceBinding, null);
  });

  test("no binding is minted when the manifest has no mapping (legacy)", () => {
    const r = correlate(PLAN, [], withSlice("S5", "Beta"));
    assert.equal(r.slicePhaseIndex, 1); // rung 3 still resolves
    assert.equal(r.newSliceBinding, null);
  });
});

describe("correlate — task ladder", () => {
  const withTask = (id: string, title: string): BridgeStatus => ({ ...BASE, activeTask: { id, title } });

  test("rung 1: persisted gsdTask resolves to the containing phase", () => {
    const r = correlate(PLAN, bound(null, "T42"), withTask("T42", "Renamed By GSD"));
    assert.deepEqual(r.taskTarget, { kind: "phase", phaseIndex: 1 });
    assert.equal(r.newTaskBinding, null);
  });

  test("rung 2: unique task tag resolves and binds", () => {
    const r = correlate(PLAN, MAPPING, withTask("T7", "Invented Task [PF3-P2-T1]"));
    assert.deepEqual(r.taskTarget, { kind: "phase", phaseIndex: 1 });
    assert.deepEqual(r.newTaskBinding, { phaseIndex: 1, taskIndex: 0, gsdTask: "T7" });
  });

  test("rung 3a: checklist-item text match paints the item (no binding — items have no manifest entry)", () => {
    const r = correlate(PLAN, MAPPING, withTask("T7", "Ship it now."));
    assert.deepEqual(r.taskTarget, { kind: "item", itemIndex: 2 }); // flat: Do(0), Check(1), Ship(2)
    assert.equal(r.newTaskBinding, null);
  });

  test("rung 3b: h4 heading match paints the containing phase and binds", () => {
    const r = correlate(PLAN, MAPPING, withTask("T7", "Second task"));
    assert.deepEqual(r.taskTarget, { kind: "phase", phaseIndex: 1 });
    assert.deepEqual(r.newTaskBinding, { phaseIndex: 1, taskIndex: 0, gsdTask: "T7" });
  });

  test("no task-level ordinal rung: single-task plan with unmatched title stays unmatched", () => {
    const single = makePlan([{ title: "Phase 1: Only", tasks: [{ title: "1. Sole task", items: ["Item one."] }] }]);
    const r = correlate(single, mappingViewOf(null), withTask("T1", "Invented Task Name"));
    assert.equal(r.taskTarget, null);
    assert.deepEqual(r.unmatched, ["Invented Task Name"]);
  });
});

describe("mappingViewOf", () => {
  test("reads a manifest mapping, filling canonical pf3Ids for legacy entries", () => {
    const view = mappingViewOf({
      mapping: { phases: [{ title: "Phase 1: Alpha", gsdSlice: "S1", tasks: [{ title: "1. First task" }] }] },
    });
    assert.deepEqual(view, [
      { title: "Phase 1: Alpha", pf3Id: "PF3-P1", gsdSlice: "S1", tasks: [{ title: "1. First task", pf3Id: "PF3-P1-T1", gsdTask: null }] },
    ]);
  });
  test("tolerates null / garbage -> empty view", () => {
    assert.deepEqual(mappingViewOf(null), []);
    assert.deepEqual(mappingViewOf({ mapping: { phases: "nope" } }), []);
  });
});
