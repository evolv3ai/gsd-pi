// Project/App: gsd-pi
// File Purpose: Tests for the milestone merge transaction wrapper.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createMilestoneMergeTransaction,
  runMilestoneMergeTransaction,
} from "../milestone-merge-transaction.js";

test("runMilestoneMergeTransaction delegates to the supplied merge runner", () => {
  const calls: unknown[][] = [];
  const result = runMilestoneMergeTransaction(
    {
      mergeMilestoneToMain: (basePath, milestoneId, roadmapContent) => {
        calls.push([basePath, milestoneId, roadmapContent]);
        return { pushed: true, codeFilesChanged: true, commitMessage: "merge M001" };
      },
    },
    {
      basePath: "/repo",
      milestoneId: "M001",
      roadmapContent: "# M001",
    },
  );

  assert.deepEqual(calls, [["/repo", "M001", "# M001"]]);
  assert.deepEqual(result, {
    pushed: true,
    codeFilesChanged: true,
    commitMessage: "merge M001",
  });
});

test("createMilestoneMergeTransaction returns a lifecycle-compatible runner", () => {
  const runner = createMilestoneMergeTransaction(() => ({
    pushed: false,
    codeFilesChanged: false,
  }));

  assert.deepEqual(runner("/repo", "M002", "# M002"), {
    pushed: false,
    codeFilesChanged: false,
  });
});
