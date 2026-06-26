// Project/App: gsd-pi
// File Purpose: Pin subagent cwd to the parent milestone worktree so parallel
// reactive-execute children cannot spawn at the project root.

import path from "node:path";

import { isGsdWorktreePath } from "../gsd/worktree-root.js";

function pathInside(parent: string, target: string): boolean {
	const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
	return target === parent || target.startsWith(parentWithSep);
}

/**
 * Resolve the cwd for a subagent child. When the parent is already inside a GSD
 * milestone worktree, children must stay in that worktree — even if the model
 * omits `cwd` or passes the project root (the root-write leak vector for
 * reactive-execute).
 */
export function resolveSubagentWorktreeCwd(parentCwd: string, taskCwd?: string): string {
	const resolvedParent = path.resolve(parentCwd);
	if (!isGsdWorktreePath(resolvedParent)) {
		return taskCwd ? path.resolve(resolvedParent, taskCwd) : resolvedParent;
	}
	if (!taskCwd) {
		return resolvedParent;
	}
	const resolvedTask = path.isAbsolute(taskCwd)
		? path.resolve(taskCwd)
		: path.resolve(resolvedParent, taskCwd);
	if (pathInside(resolvedParent, resolvedTask)) {
		return resolvedTask;
	}
	return resolvedParent;
}
