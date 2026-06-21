// Project/App: gsd-pi
// File Purpose: Unit tests for formatCompatHealthLine (doctor compat output).
// Covers the per-section "no baseline" signal introduced to fix COMMENT:3449128458.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { formatCompatHealthLine } from "../commands-handlers.ts";
import { writeCompatMarker } from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];
function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-chl-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("returns unified no-baseline when projections empty and planning inactive", async () => {
  const base = makeTmpBase();
  // No marker written → EMPTY_MARKER → projections={}, planning.active=false
  const line = await formatCompatHealthLine(base);
  assert.ok(line.includes("no baseline"), `expected no-baseline, got: ${line}`);
  // Should be the unified single line, not separate .gsd/.planning sections.
  assert.ok(!line.includes("(.gsd)"), `expected unified line, got: ${line}`);
});

test("returns per-section no-baseline for .gsd when planning active but gsd projections empty", async () => {
  // Regression: COMMENT:3449128458 — after auto-activation, marker has
  // planning.active=true but marker.projections={} (no .gsd/ baseline yet).
  // Old code reported ".gsd: OK" (misleading). New code: per-section no-baseline.
  const base = makeTmpBase();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const line = await formatCompatHealthLine(base);
  // Both sections should show no-baseline.
  const gsdLine = line.split("\n").find((l) => l.includes("(.gsd)"));
  const planningLine = line.split("\n").find((l) => l.includes("(.planning)"));
  assert.ok(gsdLine, "expected a (.gsd) line");
  assert.ok(planningLine, "expected a (.planning) line");
  assert.ok(gsdLine!.includes("no baseline"), `(.gsd) should say no baseline, got: ${gsdLine}`);
  assert.ok(planningLine!.includes("no baseline"), `(.planning) should say no baseline, got: ${planningLine}`);
});

test("returns no-baseline for .planning section when active but planning projections empty", async () => {
  // Mixed: .gsd/ has a baseline but .planning/ has been auto-activated with
  // empty projections (sync ran for .gsd but not yet for .planning/).
  const base = makeTmpBase();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {
      "milestones/M001/M001-ROADMAP.md": { sha: "abc123", entities: ["M001"] },
    },
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const line = await formatCompatHealthLine(base);
  const gsdLine = line.split("\n").find((l) => l.includes("(.gsd)"));
  const planningLine = line.split("\n").find((l) => l.includes("(.planning)"));
  assert.ok(gsdLine, "expected a (.gsd) line");
  assert.ok(planningLine, "expected a (.planning) line");
  // .gsd/ has a baseline (1 entry), file is absent → 0 drift → OK
  assert.ok(gsdLine!.includes("OK"), `(.gsd) should say OK, got: ${gsdLine}`);
  // .planning/ has no SHAs at all → no baseline
  assert.ok(planningLine!.includes("no baseline"), `(.planning) should say no baseline, got: ${planningLine}`);
});

test("reports not-active for .planning when planning is inactive", async () => {
  const base = makeTmpBase();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {
      "milestones/M001/M001-ROADMAP.md": { sha: "abc123", entities: ["M001"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const line = await formatCompatHealthLine(base);
  const planningLine = line.split("\n").find((l) => l.includes("(.planning)"));
  assert.ok(planningLine, "expected a (.planning) line");
  assert.ok(planningLine!.includes("not active"), `(.planning) should say not active, got: ${planningLine}`);
});
