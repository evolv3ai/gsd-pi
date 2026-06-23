import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePlanf3Html } from "./planf3-html-parser.ts";

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
