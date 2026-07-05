import test from "node:test";
import assert from "node:assert/strict";

import {
  createAndEnterWorktree,
  type WorktreeCreateDependencies,
  type WorktreeCreateRuntime,
} from "../worktree-cli-create.ts";

function makeRuntime(): WorktreeCreateRuntime & { cwd: string | null; output: string; env: Record<string, string | undefined> } {
  const runtime = {
    cwd: null as string | null,
    output: "",
    env: {} as Record<string, string | undefined>,
    chdir(path: string): void {
      runtime.cwd = path;
    },
    writeStderr(message: string): void {
      runtime.output += message;
    },
  };
  return runtime;
}

function makeDeps(hookError: string | null = null): WorktreeCreateDependencies {
  return {
    createWorktree: (basePath, name) => {
      assert.equal(basePath, "/repo");
      assert.equal(name, "alpha");
      return { path: "/repo/.gsd-worktrees/alpha", branch: "worktree/alpha" };
    },
    runWorktreePostCreateHook: (basePath, wtPath) => {
      assert.equal(basePath, "/repo");
      assert.equal(wtPath, "/repo/.gsd-worktrees/alpha");
      return hookError;
    },
  };
}

test("createAndEnterWorktree creates, runs the hook, and enters the session", () => {
  const runtime = makeRuntime();

  createAndEnterWorktree(makeDeps(), "/repo", "alpha", runtime);

  assert.equal(runtime.cwd, "/repo/.gsd-worktrees/alpha");
  assert.equal(runtime.env.GSD_CLI_WORKTREE, "alpha");
  assert.equal(runtime.env.GSD_CLI_WORKTREE_BASE, "/repo");
  assert.match(runtime.output, /Created worktree/);
  assert.match(runtime.output, /alpha/);
});

test("createAndEnterWorktree surfaces post-create hook warnings before entering", () => {
  const runtime = makeRuntime();

  createAndEnterWorktree(makeDeps("hook skipped"), "/repo", "alpha", runtime);

  assert.match(runtime.output, /\[gsd\] hook skipped/);
  assert.match(runtime.output, /Created worktree/);
  assert.ok(runtime.output.indexOf("hook skipped") < runtime.output.indexOf("Created worktree"));
});
