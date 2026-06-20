// gsd-pi — ADR-034 Publication module tests.
//
// Exercises publishMilestone against real local git fixtures (a bare repo as
// the remote) — no network, no gh. The PR path is only tested up to its
// non-fatal failure contract, since createDraftPullRequestFromEvidence shells
// out to gh.

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { gitRemoteExists, publishMilestone } from "../publication.ts";
import { git, makeTempDir, makeTempRepo } from "./test-utils.ts";

function makeRepoWithBareRemote(): { repo: string; bare: string; cleanup: () => void } {
  const repo = makeTempRepo("gsd-publication-test-");
  const bare = join(makeTempDir("gsd-publication-remote-"), "remote.git");
  git(repo, "init", "--bare", bare);
  git(repo, "remote", "add", "origin", bare);
  return {
    repo,
    bare,
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    },
  };
}

const NO_PUBLISH_PREFS = { autoPush: false, autoPr: false };

function makeRequest(repo: string, prefs: { autoPush: boolean; autoPr: boolean; remote?: string; prTargetBranch?: string }) {
  return {
    basePath: repo,
    milestoneId: "M001",
    milestoneTitle: "Test milestone",
    integrationBranch: "main",
    milestoneBranch: "milestone/M001",
    sliceSummaries: ["### S01\nSlice one"],
    nothingToCommit: false,
    prefs,
  };
}

test("gitRemoteExists distinguishes configured from missing remotes", () => {
  const { repo, cleanup } = makeRepoWithBareRemote();
  try {
    assert.equal(gitRemoteExists(repo, "origin"), true);
    assert.equal(gitRemoteExists(repo, "upstream"), false);
  } finally {
    cleanup();
  }
});

test("auto-push pushes the integration branch to the remote", () => {
  const { repo, bare, cleanup } = makeRepoWithBareRemote();
  try {
    const result = publishMilestone(makeRequest(repo, { autoPush: true, autoPr: false }));
    assert.equal(result.pushed, true);
    assert.equal(result.prCreated, false);
    const remoteHeads = git(repo, "ls-remote", "--heads", bare);
    assert.match(remoteHeads, /refs\/heads\/main/);
  } finally {
    cleanup();
  }
});

test("auto-push is suppressed when auto-PR owns the remote interaction", () => {
  const { repo, bare, cleanup } = makeRepoWithBareRemote();
  try {
    git(repo, "branch", "milestone/M001");
    const result = publishMilestone(makeRequest(repo, { autoPush: true, autoPr: true }));
    // PR creation pushes the milestone branch, then fails non-fatally at gh.
    assert.equal(result.pushed, false);
    assert.equal(result.prCreated, false);
    assert.equal(result.prUrl, undefined);
    const remoteHeads = git(repo, "ls-remote", "--heads", bare);
    assert.match(remoteHeads, /refs\/heads\/milestone\/M001/);
    assert.doesNotMatch(remoteHeads, /refs\/heads\/main/);
  } finally {
    cleanup();
  }
});

test("nothing-to-commit short-circuits all publication", () => {
  const { repo, bare, cleanup } = makeRepoWithBareRemote();
  try {
    const result = publishMilestone({
      ...makeRequest(repo, { autoPush: true, autoPr: false }),
      nothingToCommit: true,
    });
    assert.deepEqual(result, { pushed: false, prCreated: false });
    const remoteHeads = git(repo, "ls-remote", "--heads", bare);
    assert.equal(remoteHeads.trim(), "");
  } finally {
    cleanup();
  }
});

test("missing remote makes publication a silent no-op", () => {
  const { repo, cleanup } = makeRepoWithBareRemote();
  try {
    git(repo, "remote", "remove", "origin");
    const result = publishMilestone(makeRequest(repo, { autoPush: true, autoPr: true }));
    assert.deepEqual(result, { pushed: false, prCreated: false });
  } finally {
    cleanup();
  }
});

test("publication disabled returns the empty result without touching git", () => {
  const { repo, cleanup } = makeRepoWithBareRemote();
  try {
    const result = publishMilestone(makeRequest(repo, NO_PUBLISH_PREFS));
    assert.deepEqual(result, { pushed: false, prCreated: false });
  } finally {
    cleanup();
  }
});
