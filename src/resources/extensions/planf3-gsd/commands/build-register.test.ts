import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatPrefsLine } from "./build-register.js";
import type { PrefsSummary } from "./build.js";

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
  test("no commands", () => {
    assert.equal(formatPrefsLine(base), "prefs=updated .gsd/PREFERENCES.md (buckets: planning; no verification commands)");
  });
});
