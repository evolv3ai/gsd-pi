// gsd-pi — Regression tests: system.md documents the flat-phase layout, not legacy milestone/slice/task paths

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const promptsDir = join(process.cwd(), "src/resources/extensions/gsd/prompts");

function readPrompt(name: string): string {
  return readFileSync(join(promptsDir, `${name}.md`), "utf-8");
}

test("system.md does not advertise legacy milestone/slice/task artifact paths", () => {
  const prompt = readPrompt("system");
  for (const legacy of [".gsd/milestones", "milestones/M001", "slices/S01", "tasks/T01-PLAN.md"]) {
    assert.ok(
      !prompt.includes(legacy),
      `system.md must not reference the legacy path fragment "${legacy}" after flat-phase migration`,
    );
  }
});

test("system.md documents the flat-phase directory structure", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /phases\/\{MM\}-\{slug\}/, "system.md must document phases/{MM}-{slug}/ directories");
  assert.match(prompt, /\{MM\}-\{SS\}-PLAN\.md/, "system.md must document {MM}-{SS}-PLAN.md slice plans");
  assert.match(
    prompt,
    /do not expect `tasks\/T##-PLAN\.md`/,
    "system.md must state task plan content lives inside the slice plan, not tasks/T##-PLAN.md",
  );
});
