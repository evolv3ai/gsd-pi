import test from "node:test";
import assert from "node:assert/strict";

import {
  enterWorktreeSession,
  formatWorktreeSessionMessage,
  type WorktreeSessionRuntime,
} from "../worktree-cli-session.ts";

function makeRuntime(): WorktreeSessionRuntime & { cwd: string | null; output: string } {
  return {
    cwd: null,
    env: {},
    output: "",
    chdir(path: string): void {
      this.cwd = path;
    },
    writeStderr(message: string): void {
      this.output += message;
    },
  };
}

test("enterWorktreeSession centralizes cwd, env, and resume output", () => {
  const runtime = makeRuntime();

  enterWorktreeSession(
    { name: "alpha", path: "/repo/.gsd-worktrees/alpha", branch: "worktree/alpha" },
    "/repo",
    "Resumed",
    runtime,
  );

  assert.equal(runtime.cwd, "/repo/.gsd-worktrees/alpha");
  assert.equal(runtime.env.GSD_CLI_WORKTREE, "alpha");
  assert.equal(runtime.env.GSD_CLI_WORKTREE_BASE, "/repo");
  assert.match(runtime.output, /Resumed worktree/);
  assert.match(runtime.output, /alpha/);
  assert.match(runtime.output, /path\s+\/repo\/\.gsd-worktrees\/alpha/);
  assert.match(runtime.output, /branch\s+worktree\/alpha/);
});

test("formatWorktreeSessionMessage preserves create and resume wording", () => {
  const created = formatWorktreeSessionMessage(
    { name: "beta", path: "/repo/.gsd-worktrees/beta", branch: "worktree/beta" },
    "Created",
  );
  const resumed = formatWorktreeSessionMessage(
    { name: "beta", path: "/repo/.gsd-worktrees/beta", branch: "worktree/beta" },
    "Resumed",
  );

  assert.match(created, /Created worktree/);
  assert.match(resumed, /Resumed worktree/);
  assert.match(created, /path\s+\/repo\/\.gsd-worktrees\/beta/);
  assert.match(resumed, /branch\s+worktree\/beta/);
  assert.equal(created.endsWith("\n\n"), true);
  assert.equal(resumed.endsWith("\n\n"), true);
});
