import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const promptPath = join(process.cwd(), "src/resources/extensions/gsd/prompts/complete-slice.md");
const prompt = readFileSync(promptPath, "utf-8");

test("complete-slice prompt explains the flat task summary layout", () => {
  assert.match(prompt, /flat file layout/i);
  assert.match(prompt, /T01-SUMMARY\.md/);
  assert.match(prompt, /not inside per-task subdirectories like `tasks\/T01\/SUMMARY\.md`/i);
});

test("complete-slice prompt forbids the wrong task summary glob", () => {
  assert.match(prompt, /find .*tasks -name "\*-SUMMARY\.md"/i);
  assert.match(prompt, /Never use `tasks\/\*\/SUMMARY\.md`/);
});

test("complete-slice prompt guards the task summary find against a missing tasks dir", () => {
  assert.match(prompt, /find\s+.*tasks\s+-name\s+"\*-SUMMARY\.md"\s+2>\s*\/dev\/null\s*\|\|\s*true/i);
});
