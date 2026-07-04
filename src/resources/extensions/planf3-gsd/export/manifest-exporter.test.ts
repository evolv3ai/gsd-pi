import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import { buildManifest } from "./manifest-exporter.js";

const here = dirname(fileURLToPath(import.meta.url));
const minimal = readFileSync(
  join(here, "..", "fixtures", "minimal-plan.html"),
  "utf8",
);

describe("buildManifest", () => {
  test("produces the PRD schema with phase mapping and provenance", () => {
    const plan = parsePlanf3Html(minimal);
    const mf = buildManifest(plan, {
      htmlPath: "specs/minimal.html",
      specPath: "specs/minimal.gsd.md",
      projectRoot: ".",
    }, { userPrompt: "Test the bridge", mode: "step" });

    assert.equal(mf.schemaVersion, 1);
    assert.equal(mf.planf3.htmlPath, "specs/minimal.html");
    assert.equal(mf.planf3.title, "Minimal Plan");
    assert.equal(mf.planf3.created, "2026-06-22T10:00:00-05:00");
    assert.deepEqual(mf.planf3.modified, ["2026-06-22T10:00:00-05:00"]);

    assert.equal(mf.gsd.specPath, "specs/minimal.gsd.md");
    assert.equal(mf.gsd.projectRoot, ".");
    assert.equal(mf.gsd.milestoneId, null);
    assert.equal(mf.gsd.headlessSessionId, null);
    assert.equal(mf.gsd.mode, "step");

    assert.equal(mf.mapping.phases.length, 2);
    assert.equal(mf.mapping.phases[0].title, "Phase 1: Setup");
    assert.equal(mf.mapping.phases[0].planf3Selector, "section#phases > div.phase:nth-of-type(1)");
    assert.equal(mf.mapping.phases[0].gsdMilestone, null);
    assert.equal(mf.mapping.phases[0].gsdSlice, null);
    assert.equal(mf.mapping.phases[0].tasks.length, 2);
    assert.equal(mf.mapping.phases[0].tasks[0].title, "1. Scaffolding");
    assert.equal(mf.mapping.phases[0].tasks[0].gsdTask, null);

    assert.deepEqual(mf.validation.commands, [
      "pnpm run verify:pr",
      "pnpm run typecheck:extensions",
    ]);
    assert.equal(mf.validation.lastSyncedAt, null);
    assert.equal(mf.validation.lastStatus, "planned");

    assert.equal(mf.provenance.userPrompt, "Test the bridge");
    assert.equal(mf.provenance.generator, "planf3-gsd-pi");
    assert.equal(mf.provenance.generatorVersion, "0.1.0");
  });
});
