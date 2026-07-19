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
    assert.equal(mf.mapping.phases[0].tier, "mechanical");
    assert.deepEqual(mf.mapping.phases[0].checks, ["pnpm test"]);
    assert.equal(mf.mapping.phases[0].tasks[0].tier, "complex");
    assert.equal(mf.mapping.phases[1].tier, null);
    assert.deepEqual(mf.mapping.phases[1].checks, []);
    assert.deepEqual(mf.routing.modelPolicy, {
      planning: "openrouter/anthropic/claude-opus-4.7",
      execution: "openrouter/x-ai/grok-code-fast-1",
    });
    assert.deepEqual(mf.product, [
      { service: "OpenRouter", envVars: ["OPENROUTER_API_KEY"] },
      { service: "Neon", envVars: ["DATABASE_URL"] },
    ]);
    assert.equal(mf.presets, null);

    assert.deepEqual(mf.validation.commands, [
      "pnpm run verify:pr",
      "pnpm run typecheck:extensions",
    ]);
    assert.equal(mf.validation.lastSyncedAt, null);
    assert.equal(mf.validation.lastStatus, "planned");

    assert.equal(mf.provenance.userPrompt, "Test the bridge");
    assert.equal(mf.provenance.generator, "planf3-gsd-pi");
    assert.equal(mf.provenance.generatorVersion, "0.5.2");
  });

  test("presets block is stamped when provided", () => {
    const plan = parsePlanf3Html(minimal);
    const paths = {
      htmlPath: "specs/minimal.html",
      specPath: "specs/minimal.gsd.md",
      projectRoot: ".",
    };
    const prov = { userPrompt: "Test the bridge", mode: "step" as const };
    const manifest = buildManifest(plan, paths, prov, { path: "specs/PRESETS.md", approvalHash: "abc123" });
    assert.deepEqual(manifest.presets, { path: "specs/PRESETS.md", approvalHash: "abc123" });
  });

  test("mapping carries deterministic pf3Ids; re-export is stable", () => {
    const plan = parsePlanf3Html(minimal);
    const paths = {
      htmlPath: "specs/minimal.html",
      specPath: "specs/minimal.gsd.md",
      projectRoot: ".",
    };
    const prov = { userPrompt: "Test the bridge", mode: "step" as const };
    const a = buildManifest(plan, paths, prov);
    const b = buildManifest(plan, paths, prov);
    assert.equal(a.mapping.phases[0].pf3Id, "PF3-P1");
    assert.equal(a.mapping.phases[0].tasks[0].pf3Id, "PF3-P1-T1");
    assert.deepEqual(
      a.mapping.phases.map((p) => [p.pf3Id, p.tasks.map((t) => t.pf3Id)]),
      b.mapping.phases.map((p) => [p.pf3Id, p.tasks.map((t) => t.pf3Id)]),
    );
    // re-export resets bindings: a fresh manifest never carries gsdSlice/gsdTask
    assert.equal(a.mapping.phases[0].gsdSlice, null);
    assert.equal(a.mapping.phases[0].tasks[0].gsdTask, null);
  });
});
