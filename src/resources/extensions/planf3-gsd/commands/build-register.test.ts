import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatPrefsLine, formatBuildSummary } from "./build-register.js";
import type { PrefsSummary, BuildResult } from "./build.js";

const base: PrefsSummary = { applied: true, buckets: ["planning"], models: { planning: "m" }, commands: [], warning: null };

describe("formatPrefsLine", () => {
  test("warning wins", () => {
    assert.equal(formatPrefsLine({ ...base, applied: false, warning: "bad yaml" }), "prefs=skipped (bad yaml)");
  });
  test("not applied", () => {
    assert.equal(formatPrefsLine({ ...base, applied: false }), "prefs=no changes");
  });
  test("lists the actual verification commands (trust surface)", () => {
    const line = formatPrefsLine({ ...base, commands: ["pnpm run verify:pr", "pnpm run typecheck:extensions"] });
    assert.equal(line, "prefs=updated .gsd/PREFERENCES.md (buckets: planning; verification commands: pnpm run verify:pr, pnpm run typecheck:extensions)");
  });
  test("caps the listing at 5 with +N more", () => {
    const commands = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
    const line = formatPrefsLine({ ...base, commands });
    assert.equal(line, "prefs=updated .gsd/PREFERENCES.md (buckets: planning; verification commands: c1, c2, c3, c4, c5 +2 more)");
  });
  test("exactly 5 commands: all listed, no +N more suffix (boundary)", () => {
    const commands = ["c1", "c2", "c3", "c4", "c5"];
    const line = formatPrefsLine({ ...base, commands });
    assert.equal(line, "prefs=updated .gsd/PREFERENCES.md (buckets: planning; verification commands: c1, c2, c3, c4, c5)");
  });
  test("no commands", () => {
    assert.equal(formatPrefsLine(base), "prefs=updated .gsd/PREFERENCES.md (buckets: planning; no verification commands)");
  });
});

function makeResult(overrides: Partial<BuildResult>): BuildResult {
  return {
    specPath: "/tmp/p.gsd.md",
    manifestPath: "/tmp/p.manifest.json",
    milestoneId: "M042",
    autoChain: "not-applicable",
    status: {
      phase: "ready",
      activeMilestone: null,
      lastCompletedMilestone: null,
      activeSlice: null,
      activeTask: null,
      progress: null,
      cost: 0,
      nextAction: null,
      blockers: [],
      sessionId: null,
    },
    prefs: { applied: false, buckets: [], models: {}, commands: [], warning: null },
    presets: "ok",
    postSync: null,
    ...overrides,
  };
}

describe("formatBuildSummary", () => {
  test("step-mode result (autoChain not-applicable) has no auto= line", () => {
    assert.equal(
      formatBuildSummary(makeResult({})),
      "Built milestone M042\nphase=ready\nprefs=no changes\nspec=/tmp/p.gsd.md\nmanifest=/tmp/p.manifest.json",
    );
  });

  test("auto result carries the auto= line and (unknown id) fallback", () => {
    assert.equal(
      formatBuildSummary(makeResult({ milestoneId: null, autoChain: "chained" })),
      "Built milestone (unknown id)\nphase=ready\nauto=chained\nprefs=no changes\nspec=/tmp/p.gsd.md\nmanifest=/tmp/p.manifest.json",
    );
  });

  test("formatBuildSummary carries sync=<kind> when the build-return sync ran", () => {
    const result = makeResult({ postSync: { ran: true, kind: "synced", message: "synced 8 marker(s)" } });
    assert.ok(formatBuildSummary(result).includes("sync=synced"));
  });
  test("formatBuildSummary points at /planf3-gsd-sync when the sync failed", () => {
    const result = makeResult({ postSync: { ran: false, error: "boom" } });
    assert.ok(formatBuildSummary(result).includes("sync=failed — run /planf3-gsd-sync"));
  });
});
