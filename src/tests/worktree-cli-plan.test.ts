import test from "node:test";
import assert from "node:assert/strict";

import { planWorktreeFlag, type WorktreeCliWorktree } from "../worktree-cli-plan.ts";

const alpha: WorktreeCliWorktree = {
  name: "alpha",
  path: "/repo/.gsd-worktrees/alpha",
  branch: "worktree/alpha",
};
const beta: WorktreeCliWorktree = {
  name: "beta",
  path: "/repo/.gsd-worktrees/beta",
  branch: "worktree/beta",
};

function named(name: string): string {
  assert.equal(name, "generated");
  return name;
}

test("bare -w resumes the only worktree with changes", () => {
  assert.deepEqual(planWorktreeFlag(true, [alpha, beta], [alpha], named), {
    action: "resume",
    worktree: alpha,
  });
});

test("bare -w asks the user to choose when multiple worktrees have changes", () => {
  assert.deepEqual(planWorktreeFlag(true, [alpha, beta], [alpha, beta], named), {
    action: "show-multiple",
    worktrees: [alpha, beta],
  });
});

test("bare -w creates a generated worktree when no worktree has changes", () => {
  assert.deepEqual(planWorktreeFlag(true, [alpha], [], () => "generated"), {
    action: "create",
    name: "generated",
  });
});

test("named -w resumes an existing worktree or creates the requested name", () => {
  assert.deepEqual(planWorktreeFlag("alpha", [alpha], [], () => "unused"), {
    action: "resume",
    worktree: alpha,
  });
  assert.deepEqual(planWorktreeFlag("gamma", [alpha], [], () => "unused"), {
    action: "create",
    name: "gamma",
  });
});

test("defensive false worktree flag falls back to generated create plan", () => {
  assert.deepEqual(planWorktreeFlag(false, [alpha], [], () => "generated"), {
    action: "create",
    name: "generated",
  });
});
