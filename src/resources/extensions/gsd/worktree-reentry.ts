// Project/App: gsd-pi
// File Purpose: Deterministically re-enter the active milestone's worktree on a
// cold start (after /quit + relaunch). Without this, Claude Code relaunches with
// cwd at the project root, and a bare /gsd leaves the agent there — forcing it to
// search the filesystem ("git worktree list", branch sniffing) to find its way
// back into the worktree. The worktree path is fully derivable from state, so we
// resolve and chdir into it directly instead.

import { readdirSync } from "node:fs";

import { enterAutoWorktree } from "./auto-worktree-entry.js";
import { getAutoWorktreePath } from "./auto-worktree-path-resolution.js";
import { getIsolationMode } from "./preferences.js";
import { allWorktreesDirs } from "./worktree-manager.js";
import { isGsdWorktreePath, resolveWorktreeProjectRoot } from "./worktree-root.js";

interface LiveWorktree {
  id: string;
  path: string;
}

/**
 * Enumerate the live (valid git) auto-worktrees in the project's worktree
 * containers (canonical .gsd-worktrees/ and legacy .gsd/worktrees/).
 * Reuses getAutoWorktreePath's validation so stray directories are ignored.
 */
function liveMilestoneWorktrees(projectRoot: string): LiveWorktree[] {
  const names = new Set<string>();
  for (const dir of allWorktreesDirs(projectRoot)) {
    try {
      for (const name of readdirSync(dir)) names.add(name);
    } catch {
      // container absent — skip
    }
  }
  const live: LiveWorktree[] = [];
  for (const id of names) {
    const path = getAutoWorktreePath(projectRoot, id);
    if (path) live.push({ id, path });
  }
  return live;
}

/**
 * If we're sitting at the project root with worktree isolation enabled and the
 * active milestone has a live worktree, chdir into it. No-op when already inside
 * a worktree, when isolation is off, or when the target is ambiguous.
 *
 * Single live worktree → enter it (covers the common case without deriveState).
 * Multiple live worktrees → disambiguate by the active milestone from state;
 * if that can't be resolved unambiguously, do nothing.
 *
 * Best-effort: any failure resolves to a no-op so it can never block startup.
 *
 * @returns the worktree path entered, or null when nothing was done.
 */
export async function reenterActiveWorktreeIfNeeded(
  basePath: string,
  opts: { notify?: (message: string) => void } = {},
): Promise<string | null> {
  let projectRoot: string;
  try {
    projectRoot = resolveWorktreeProjectRoot(basePath);
  } catch {
    return null;
  }

  // Only worktree-isolation projects have worktrees to re-enter.
  if (getIsolationMode(projectRoot) !== "worktree") return null;

  // Already inside a worktree (warm session, or auto-mode already entered) —
  // nothing to do.
  let cwd: string;
  try {
    cwd = process.cwd();
  } catch {
    return null;
  }
  if (isGsdWorktreePath(cwd)) return null;

  const live = liveMilestoneWorktrees(projectRoot);
  if (live.length === 0) return null;

  let target: LiveWorktree | null = live.length === 1 ? live[0]! : null;
  if (!target) {
    // Multiple live worktrees — disambiguate by the active milestone.
    try {
      const { deriveState } = await import("./state.js");
      const state = await deriveState(projectRoot);
      const activeId = state.activeMilestone?.id;
      target = activeId ? live.find((w) => w.id === activeId) ?? null : null;
    } catch {
      target = null;
    }
  }
  if (!target) return null;

  try {
    const entered = enterAutoWorktree(projectRoot, target.id);
    opts.notify?.(`Resumed in worktree for ${target.id}.`);
    return entered;
  } catch {
    // Worktree vanished or chdir failed — leave cwd as-is, caller falls back to
    // the project root.
    return null;
  }
}
