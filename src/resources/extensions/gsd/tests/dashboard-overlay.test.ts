/**
 * GSD dashboard overlay dialog chrome tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { GSDDashboardOverlay } from "../dashboard-overlay.ts";
import type { UnitMetrics } from "../metrics.ts";
import { assertFullOuterBorder } from "./tui-border-assertions.ts";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("GSDDashboardOverlay renders inside the shared full border", (t) => {
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  const lines = overlay.render(100);
  assertFullOuterBorder(lines, 100);
  assert.match(lines[0] ?? "", /^╭─ GSD Dashboard /);
  assert.ok(lines.some((line) => line.startsWith("│")), "body rows should have side borders");
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
});

test("GSDDashboardOverlay reuses metrics aggregations until the unit count changes", (t) => {
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  const firstUnits = [makeUnit("M001/S001/T001", 0.25)];
  const firstMetrics = (overlay as any).ensureMetricsCache(firstUnits);

  overlay.invalidate();

  const sameCountUnits = [makeUnit("M001/S001/T002", 0.5)];
  const sameCountMetrics = (overlay as any).ensureMetricsCache(sameCountUnits);
  assert.equal(sameCountMetrics, firstMetrics, "same unit count should reuse cached metrics");
  assert.equal(sameCountMetrics.totals.cost, 0.25);

  const increasedCountMetrics = (overlay as any).ensureMetricsCache([
    ...sameCountUnits,
    makeUnit("M001/S001/T003", 0.75),
  ]);
  assert.notEqual(increasedCountMetrics, firstMetrics, "changed unit count should recompute metrics");
  assert.equal(increasedCountMetrics.totals.units, 2);
  assert.equal(increasedCountMetrics.totals.cost, 1.25);
});

function makeUnit(id: string, cost: number): UnitMetrics {
  return {
    type: "execute-task",
    id,
    model: "claude-sonnet-4.5",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 25,
      cacheWrite: 10,
      total: 185,
    },
    cost,
    toolCalls: 1,
    assistantMessages: 1,
    userMessages: 1,
  };
}
