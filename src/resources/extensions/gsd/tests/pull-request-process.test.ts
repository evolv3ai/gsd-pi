// Project/App: gsd-pi
// File Purpose: Tests for process-level pull request policy.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPullRequestEvidence,
  createDraftPullRequestFromEvidence,
} from "../pull-request-process.js";

test("buildPullRequestEvidence omits AI credit by policy", () => {
  const evidence = buildPullRequestEvidence({
    milestoneId: "M001",
    milestoneTitle: "Git process",
    aiAssisted: true,
  });

  assert.equal(evidence.title, "feat: Git process");
  assert.ok(!evidence.body.includes("## AI Assistance Disclosure"));
  assert.ok(!evidence.body.includes("AI assistance"));
});

test("createDraftPullRequestFromEvidence forwards exact evidence and branch options", () => {
  const calls: unknown[][] = [];
  const url = createDraftPullRequestFromEvidence(
    "/repo",
    "M001",
    { title: "feat: Git process", body: "body" },
    { head: "milestone/M001", base: "main" },
    {
      createDraftPR: (basePath, milestoneId, title, body, opts) => {
        calls.push([basePath, milestoneId, title, body, opts]);
        return "https://github.example/pr/1";
      },
    },
  );

  assert.equal(url, "https://github.example/pr/1");
  assert.deepEqual(calls, [[
    "/repo",
    "M001",
    "feat: Git process",
    "body",
    { head: "milestone/M001", base: "main" },
  ]]);
});
