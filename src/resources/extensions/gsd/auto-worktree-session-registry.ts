// gsd-pi — Auto-worktree active session registry.
//
// Owns the process-local active workspace state used by auto-worktree create,
// enter, teardown, and merge paths. Keeping this state behind a focused module
// gives registry tests the same interface production uses instead of reaching
// through the legacy auto-worktree compatibility barrel.

import { nativeGetCurrentBranch } from "./native-git-bridge.js";
import {
  isGsdWorktreePath,
  normalizeWorktreePathForCompare,
  resolveWorktreeProjectRoot,
} from "./worktree-root.js";
import { detectWorktreeName } from "./worktree.js";
import type { GsdWorkspace } from "./workspace.js";

/** Active workspace registry — replaces the legacy `originalBase` singleton. */
let activeWorkspace: GsdWorkspace | null = null;

export function setActiveWorkspace(ws: GsdWorkspace | null): void {
  activeWorkspace = ws;
}

export function getActiveWorkspace(): GsdWorkspace | null {
  return activeWorkspace;
}

/**
 * Get the original project root stored when entering an auto-worktree.
 * Returns null if not currently in an auto-worktree.
 */
export function getAutoWorktreeOriginalBase(): string | null {
  return getActiveWorkspace()?.projectRoot ?? null;
}

/**
 * Test-only — resets the module-level `activeWorkspace` registry between
 * runs. Production code never clears the registry directly; tests call this
 * in `beforeEach`/`afterEach` to isolate registry-mutating cases.
 */
export function _resetAutoWorktreeOriginalBaseForTests(): void {
  setActiveWorkspace(null);
}

export function getActiveAutoWorktreeContext(): {
  originalBase: string;
  worktreeName: string;
  branch: string;
} | null {
  const ws = getActiveWorkspace();
  if (!ws) return null;
  const originalBase = ws.projectRoot;
  const cwd = process.cwd();
  if (!isGsdWorktreePath(cwd)) return null;
  const cwdProjectRoot = resolveWorktreeProjectRoot(cwd, originalBase);
  if (
    normalizeWorktreePathForCompare(cwdProjectRoot) !==
    normalizeWorktreePathForCompare(originalBase)
  ) {
    return null;
  }
  const worktreeName = detectWorktreeName(cwd);
  if (!worktreeName) return null;
  const branch = nativeGetCurrentBranch(cwd);
  if (!branch.startsWith("milestone/")) return null;
  return {
    originalBase,
    worktreeName,
    branch,
  };
}
