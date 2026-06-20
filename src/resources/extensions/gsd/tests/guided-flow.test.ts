import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("guided milestone discussion callsites pass workingDirectory to loadPrompt", () => {
  const source = readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");

  // All guided-discuss-milestone dispatches now go through buildDiscussMilestonePrompt,
  // which centralises the loadPrompt call and always passes workingDirectory.
  // Verify no callsite bypasses the builder by calling loadPrompt directly.
  const directCalls = [...source.matchAll(/loadPrompt\("guided-discuss-milestone"/g)];
  assert.equal(
    directCalls.length,
    0,
    'guided-flow.ts must not call loadPrompt("guided-discuss-milestone") directly — use buildDiscussMilestonePrompt',
  );

  const calls = [...source.matchAll(/\bawait buildDiscussMilestonePrompt\(/g)];
  assert.equal(calls.length, 9, "all guided-flow guided-discuss-milestone callsites should be covered");
});
