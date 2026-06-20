// Project/App: gsd-pi
// File Purpose: Regression tests for subagent cwd pinning inside milestone worktrees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSubagentWorktreeCwd } from "../worktree-cwd.js";

test("resolveSubagentWorktreeCwd defaults to parent when task cwd is omitted in worktree", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-cwd-"));
	const worktree = join(root, ".gsd-worktrees", "M007");
	try {
		mkdirSync(worktree, { recursive: true });
		assert.equal(resolveSubagentWorktreeCwd(worktree), worktree);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveSubagentWorktreeCwd pins project-root cwd to parent worktree", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-cwd-"));
	const worktree = join(root, ".gsd-worktrees", "M007");
	try {
		mkdirSync(worktree, { recursive: true });
		assert.equal(resolveSubagentWorktreeCwd(worktree, root), worktree);
		assert.equal(resolveSubagentWorktreeCwd(worktree, join(root, "app.js")), worktree);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveSubagentWorktreeCwd allows relative paths inside the worktree", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-cwd-"));
	const worktree = join(root, ".gsd-worktrees", "M007");
	const nested = join(worktree, "src");
	try {
		mkdirSync(nested, { recursive: true });
		assert.equal(resolveSubagentWorktreeCwd(worktree, "src"), nested);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveSubagentWorktreeCwd leaves non-worktree parents unchanged", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-cwd-"));
	const nested = join(root, "packages", "app");
	try {
		mkdirSync(nested, { recursive: true });
		assert.equal(resolveSubagentWorktreeCwd(root), root);
		assert.equal(resolveSubagentWorktreeCwd(root, "packages/app"), nested);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
