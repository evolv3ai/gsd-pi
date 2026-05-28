import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkoutBranchWithStashGuard } from "../auto-worktree.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
}

function createRepo(t: { after: (fn: () => void) => void }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-stash-guard-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(["init"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test User"], dir);
  writeFileSync(join(dir, "note.txt"), "base\n");
  mkdirSync(join(dir, ".gsd"));
  writeFileSync(join(dir, ".gsd", "event-log.jsonl"), "{\"event\":\"base\"}\n");
  git(["add", "note.txt", ".gsd/event-log.jsonl"], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  return dir;
}

describe("checkoutBranchWithStashGuard", () => {
  test("restores dirty working tree after successful checkout", (t) => {
    const repo = createRepo(t);
    git(["checkout", "-b", "milestone/M001"], repo);
    git(["checkout", "main"], repo);

    writeFileSync(join(repo, "note.txt"), "dirty\n");

    checkoutBranchWithStashGuard(repo, "milestone/M001", "test-success");

    const branch = git(["branch", "--show-current"], repo).trim();
    assert.equal(branch, "milestone/M001");
    const content = git(["show", "HEAD:note.txt"], repo).trim();
    assert.equal(content, "base");
    const wtContent = readFileSync(join(repo, "note.txt"), "utf8");
    assert.equal(wtContent, "dirty\n");
    const status = git(["status", "--porcelain"], repo);
    assert.match(status, /note\.txt/);
  });

  test("restores dirty working tree when checkout throws", (t) => {
    const repo = createRepo(t);
    writeFileSync(join(repo, "note.txt"), "dirty\n");

    assert.throws(
      () => checkoutBranchWithStashGuard(repo, "milestone/DOES-NOT-EXIST", "test-failure"),
    );

    const status = git(["status", "--porcelain"], repo);
    assert.match(status, /note\.txt/);
    const stashList = git(["stash", "list"], repo).trim();
    assert.equal(stashList, "");
  });

  test("surfaces distinct error when checkout succeeds but stash pop conflicts", (t) => {
    const repo = createRepo(t);
    // Branch B has a divergent version of note.txt so popping a stash made
    // against main will conflict after the checkout to B.
    git(["checkout", "-b", "milestone/B"], repo);
    writeFileSync(join(repo, "note.txt"), "B-version\n");
    git(["add", "note.txt"], repo);
    git(["commit", "-m", "B"], repo);
    git(["checkout", "main"], repo);

    writeFileSync(join(repo, "note.txt"), "local\n");

    assert.throws(
      () => checkoutBranchWithStashGuard(repo, "milestone/B", "test-pop-failure"),
      /checkout to 'milestone\/B' succeeded but stash restore failed/,
    );

    const branch = git(["branch", "--show-current"], repo).trim();
    assert.equal(branch, "milestone/B");
    const stashList = git(["stash", "list"], repo).trim();
    assert.match(stashList, /gsd: checkout stash/);
  });

  test("accepts target branch .gsd files when untracked stash restore collides", (t) => {
    const repo = createRepo(t);
    git(["checkout", "-b", "milestone/M001"], repo);
    writeFileSync(join(repo, ".gsd", "PROJECT.md"), "target\n");
    git(["add", ".gsd/PROJECT.md"], repo);
    git(["commit", "-m", "add gsd state"], repo);
    git(["checkout", "main"], repo);

    writeFileSync(join(repo, ".gsd", "PROJECT.md"), "local\n");

    checkoutBranchWithStashGuard(repo, "milestone/M001", "test-gsd-collision");

    const branch = git(["branch", "--show-current"], repo).trim();
    assert.equal(branch, "milestone/M001");
    const wtContent = readFileSync(join(repo, ".gsd", "PROJECT.md"), "utf8");
    assert.equal(wtContent, "target\n");
    const status = git(["status", "--porcelain"], repo).trim();
    assert.equal(status, "");
    const stashList = git(["stash", "list"], repo).trim();
    assert.equal(stashList, "");
  });

  test("clears tracked .gsd JSONL conflict markers when untracked stash restore collides", (t) => {
    const repo = createRepo(t);
    git(["checkout", "-b", "milestone/M002"], repo);
    writeFileSync(join(repo, ".gsd", "event-log.jsonl"), "{\"event\":\"target\"}\n");
    writeFileSync(join(repo, ".gsd", "PROJECT.md"), "target\n");
    git(["add", ".gsd/event-log.jsonl", ".gsd/PROJECT.md"], repo);
    git(["commit", "-m", "update gsd state"], repo);
    git(["checkout", "main"], repo);

    writeFileSync(join(repo, ".gsd", "event-log.jsonl"), "{\"event\":\"local\"}\n");
    writeFileSync(join(repo, ".gsd", "PROJECT.md"), "local\n");

    checkoutBranchWithStashGuard(repo, "milestone/M002", "test-gsd-jsonl-marker-collision");

    const branch = git(["branch", "--show-current"], repo).trim();
    assert.equal(branch, "milestone/M002");
    const eventLog = readFileSync(join(repo, ".gsd", "event-log.jsonl"), "utf8");
    assert.equal(eventLog, "{\"event\":\"target\"}\n");
    assert.doesNotMatch(eventLog, /<<<<<<<|=======|>>>>>>>/);
    const project = readFileSync(join(repo, ".gsd", "PROJECT.md"), "utf8");
    assert.equal(project, "target\n");
    const status = git(["status", "--porcelain"], repo).trim();
    assert.equal(status, "");
    const stashList = git(["stash", "list"], repo).trim();
    assert.equal(stashList, "");
  });

  test("auto-resolves .gsd untracked restore collisions after checkout", (t) => {
    const repo = createRepo(t);
    git(["checkout", "-b", "milestone/GSD"], repo);
    mkdirSync(join(repo, ".gsd"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "DECISIONS.md"), "tracked\n");
    git(["add", ".gsd/DECISIONS.md"], repo);
    git(["commit", "-m", "add gsd state"], repo);
    git(["checkout", "main"], repo);

    mkdirSync(join(repo, ".gsd"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "DECISIONS.md"), "untracked local\n");

    checkoutBranchWithStashGuard(repo, "milestone/GSD", "test-gsd-untracked-collision");

    const branch = git(["branch", "--show-current"], repo).trim();
    assert.equal(branch, "milestone/GSD");
    const wtContent = readFileSync(join(repo, ".gsd", "DECISIONS.md"), "utf8");
    assert.equal(wtContent, "tracked\n");
    const status = git(["status", "--porcelain"], repo).trim();
    assert.equal(status, "");
    const stashList = git(["stash", "list"], repo).trim();
    assert.equal(stashList, "");
  });
});
