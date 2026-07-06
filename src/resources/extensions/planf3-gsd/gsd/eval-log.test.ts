import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvalRow, appendEvalRow } from "./eval-log.js";
import type { BridgeStatus } from "./status-mapper.js";

const STATUS: BridgeStatus = {
  phase: "done",
  activeMilestone: null,
  lastCompletedMilestone: { id: "M77", title: "Auto Plan" },
  activeSlice: null,
  activeTask: null,
  progress: { milestones: { done: 1, total: 1 }, slices: { done: 3, total: 3 }, tasks: { done: 9, total: 9 } },
  cost: 1.23,
  nextAction: null,
  blockers: [{ reason: "x" }],
  sessionId: "s-1",
};

describe("buildEvalRow", () => {
  test("maps status fields into a flat row", () => {
    const row = buildEvalRow({
      loggedAt: "2026-07-04T12:00:00Z",
      htmlPath: "specs/minimal.html",
      specPath: "specs/minimal.gsd.md",
      milestoneId: "M77",
      mode: "auto",
      status: STATUS,
      appliedBuckets: ["planning", "execution"],
      appliedModels: { planning: "openrouter/anthropic/claude-opus-4.7", execution: "openrouter/x-ai/grok-code-fast-1" },
    });
    assert.deepEqual(row, {
      loggedAt: "2026-07-04T12:00:00Z",
      event: "build",
      htmlPath: "specs/minimal.html",
      specPath: "specs/minimal.gsd.md",
      milestoneId: "M77",
      mode: "auto",
      phase: "done",
      cost: 1.23,
      progress: STATUS.progress,
      blockerCount: 1,
      appliedBuckets: ["planning", "execution"],
      appliedModels: { planning: "openrouter/anthropic/claude-opus-4.7", execution: "openrouter/x-ai/grok-code-fast-1" },
      generator: "planf3-gsd-pi",
      generatorVersion: "0.3.1",
    });
  });
});

describe("appendEvalRow", () => {
  test("appends one JSON line per call", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-eval-"));
    const row = buildEvalRow({
      loggedAt: "2026-07-04T12:00:00Z",
      htmlPath: "a.html",
      specPath: "a.gsd.md",
      milestoneId: null,
      mode: "step",
      status: STATUS,
      appliedBuckets: [],
      appliedModels: {},
    });
    await appendEvalRow(tmp, row);
    await appendEvalRow(tmp, row);
    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).event, "build");
    assert.equal(JSON.parse(lines[1]).phase, "done");
  });
});
