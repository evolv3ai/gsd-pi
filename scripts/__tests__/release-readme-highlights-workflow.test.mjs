// Project/App: gsd-pi
// File Purpose: Regression tests for README release highlights workflow wiring.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(
  readFileSync(".github/workflows/release-readme-highlights.yml", "utf8"),
);

test("release README highlights workflow triggers on published releases", () => {
  const job = workflow.jobs["update-readme"];

  assert.deepEqual(workflow.on.release.types, ["published"]);
  assert.equal(workflow.permissions.contents, "write");
  assert.match(job.if, /release\.prerelease == false/);
  assert.equal(job["runs-on"], "blacksmith-4vcpu-ubuntu-2404");
});

test("release README highlights workflow updates and commits README.md only when needed", () => {
  const steps = workflow.jobs["update-readme"].steps;
  const updateReadme = steps.find((step) => step.name === "Update README highlights");
  const commitReadme = steps.find((step) => step.name === "Commit README update");

  assert.ok(updateReadme, "workflow should run the README updater");
  assert.match(updateReadme.run, /update-readme-release-highlights\.mjs/);
  assert.match(updateReadme.run, /release-metadata\/release-notes\.md/);
  assert.ok(commitReadme, "workflow should commit README changes");
  assert.match(commitReadme.run, /git diff --quiet -- README\.md/);
  assert.match(commitReadme.run, /git add README\.md/);
  assert.match(commitReadme.run, /git push origin HEAD:main/);
});
