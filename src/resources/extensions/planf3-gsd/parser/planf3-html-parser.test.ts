import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePlanf3Html } from "./planf3-html-parser.js";
import { GSD_MODEL_PHASE_KEYS as NATIVE_KEYS } from "../../gsd/preferences-types.js";
import { GSD_MODEL_PHASE_KEYS } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const minimal = readFileSync(join(here, "..", "fixtures", "minimal-plan.html"), "utf8");

describe("parsePlanf3Html — title + metadata", () => {
  test("extracts H1 title and tagline", () => {
    const plan = parsePlanf3Html(minimal);
    assert.equal(plan.title, "Minimal Plan");
    assert.equal(plan.tagline, "A tiny plan used for parser unit tests.");
  });

  test("extracts the metadata dl", () => {
    const plan = parsePlanf3Html(minimal);
    assert.equal(plan.metadata.created, "2026-06-22T10:00:00-05:00");
    assert.deepEqual(plan.metadata.modified, ["2026-06-22T10:00:00-05:00"]);
    assert.deepEqual(plan.metadata.commits, []);          // "—" → empty
    assert.equal(plan.metadata.agentName, "test");
    assert.equal(plan.metadata.sessionId, "planf3-minimal");
    assert.deepEqual(plan.metadata.backRefs, []);
    assert.deepEqual(plan.metadata.forwardRefs, []);
  });
});

describe("parsePlanf3Html — narrative sections", () => {
  test("extracts purpose, problem, solution, notes", () => {
    const plan = parsePlanf3Html(minimal);
    assert.equal(plan.purpose, "Verify the parser.");
    assert.equal(plan.problem, "Need a deterministic fixture.");
    assert.equal(plan.solution, "Handwrite one.");
    assert.equal(plan.notes, "Test scaffolding only.");
  });
});

describe("parsePlanf3Html — relevant files", () => {
  test("extracts existing and new file entries", () => {
    const plan = parsePlanf3Html(minimal);
    assert.deepEqual(plan.existingFiles, [
      { kind: "existing", path: "src/a.ts", description: "current entry." },
    ]);
    assert.deepEqual(plan.newFiles, [
      { kind: "new", path: "src/b.ts", description: "parser output." },
    ]);
  });
});

describe("parsePlanf3Html — phases", () => {
  test("extracts phase title, status, description, tasks, and checklist statuses", () => {
    const plan = parsePlanf3Html(minimal);
    assert.equal(plan.phases.length, 2);

    const [p1, p2] = plan.phases;
    assert.equal(p1.title, "Phase 1: Setup");
    assert.equal(p1.status, "wip");
    assert.equal(p1.description, "Stand up the skeleton.");
    assert.equal(p1.tasks.length, 2);
    assert.equal(p1.tasks[0].title, "1. Scaffolding");
    assert.deepEqual(p1.tasks[0].checklist, [
      { status: "done", text: "Create the dir.", command: null },
      { status: "todo", text: "Add the file.", command: null },
    ]);
    assert.equal(p1.tasks[1].title, "2. Testing Strategy");
    assert.deepEqual(p1.tasks[1].checklist, [
      { status: "todo", text: "pnpm test", command: "pnpm test" },
    ]);

    assert.equal(p2.status, "todo");
    assert.equal(p2.tasks[0].checklist[0].status, "failed");
  });

  test("extracts optional tier chips from phase h3 and task h4, stripping them from titles", () => {
    const plan = parsePlanf3Html(minimal);
    const [p1, p2] = plan.phases;
    assert.equal(p1.tier, "mechanical");
    assert.equal(p1.title, "Phase 1: Setup");
    assert.equal(p1.tasks[0].tier, "complex");
    assert.equal(p1.tasks[0].title, "1. Scaffolding");
    assert.equal(p1.tasks[1].tier, null);
    assert.equal(p2.tier, null);
    assert.equal(p2.tasks[0].tier, null);
  });

  test("extracts bare validation commands, dropping the prose suffix", () => {
    const plan = parsePlanf3Html(minimal);
    assert.deepEqual(plan.validationCommands, [
      "pnpm run verify:pr",
      "pnpm run typecheck:extensions",
    ]);
  });

  test("extracts amendments", () => {
    const plan = parsePlanf3Html(minimal);
    assert.equal(plan.amendments.length, 1);
    assert.equal(plan.amendments[0].iso, "2026-06-22T11:00:00-05:00");
    assert.equal(plan.amendments[0].summary, "Added phase 2.");
  });
});

describe("parsePlanf3Html — model policy", () => {
  test("extracts known gsd bucket keys and drops unknown ones", () => {
    const plan = parsePlanf3Html(minimal);
    assert.deepEqual(plan.modelPolicy, {
      planning: "openrouter/anthropic/claude-opus-4.7",
      execution: "openrouter/x-ai/grok-code-fast-1",
    });
  });
});

describe("parsePlanf3Html — real fixture smoke", () => {
  test("does not throw on pi-iroh-coms-net.html and finds 4 phases", () => {
    const real = readFileSync(join(here, "..", "fixtures", "pi-iroh-coms-net.html"), "utf8");
    const plan = parsePlanf3Html(real);
    assert.equal(plan.title.length > 0, true);
    assert.equal(plan.phases.length, 4);
    for (const phase of plan.phases) {
      assert.ok(["todo", "wip", "done", "failed"].includes(phase.status));
      assert.ok(phase.title.length > 0);
      assert.equal(phase.tier, null);
    }
    assert.deepEqual(plan.modelPolicy, {});
  });
});

describe("parsePlanf3Html — integrations", () => {
  test("extracts service + env var names from #integrations", () => {
    const plan = parsePlanf3Html(minimal);
    assert.deepEqual(plan.integrations, [
      { service: "OpenRouter", envVars: ["OPENROUTER_API_KEY"] },
      { service: "Neon", envVars: ["DATABASE_URL"] },
    ]);
  });

  test("absent section → empty list", () => {
    const plan = parsePlanf3Html("<html><body><header><h1>X</h1></header></body></html>");
    assert.deepEqual(plan.integrations, []);
  });
});

describe("bucket-key parity", () => {
  test("GSD_MODEL_PHASE_KEYS matches the authoritative keys from gsd/preferences-types", () => {
    assert.deepEqual([...GSD_MODEL_PHASE_KEYS], [...NATIVE_KEYS]);
  });
});
