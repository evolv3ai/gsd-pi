import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const autoPostUnitSource = readFileSync(
  join(import.meta.dirname, "..", "auto-post-unit.ts"),
  "utf-8",
);

function extractFunctionSource(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test("runCloseoutGitAction does not invoke runGitHubSync", () => {
  const closeoutGit = extractFunctionSource(
    autoPostUnitSource,
    "async function runCloseoutGitAction",
    "export async function postUnitPreVerification",
  );
  assert.ok(!closeoutGit.includes("runGitHubSync"), "GitHub sync must not run inside closeout git");
});

test("postUnitPreVerification finalizes GitHub after complete-milestone verification", () => {
  const preVerify = extractFunctionSource(
    autoPostUnitSource,
    "export async function postUnitPreVerification",
    "export async function postUnitPostVerification",
  );
  assert.ok(preVerify.includes("runMilestoneCloseoutGitHub"), "must finalize GitHub after milestone verify");
  assert.ok(preVerify.includes("runPostUnitGitHubSyncIfNeeded"), "must sync other unit types after pre-verify");
  assert.ok(
    preVerify.includes('s.currentUnit.type === "complete-milestone"'),
    "must gate milestone GitHub finalize",
  );
});
