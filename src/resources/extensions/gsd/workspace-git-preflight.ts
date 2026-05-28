// Project/App: gsd-pi
// File Purpose: Unified workspace git preflight probe, heal, and readiness checks.

import { existsSync, realpathSync } from "node:fs";

import { getAutoWorktreePath } from "./auto-worktree.js";
import { isSafeToAutoResolve } from "./auto-worktree.js";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import {
  probeGitConflictState,
  reconcileGitConflictsOnSignal,
  type GitConflictProbeResult,
} from "./git-conflict-state.js";
import { deriveState } from "./state.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";

export type WorkspaceGitBlockSeverity = "product-conflicts" | "unrecoverable";

export type WorkspaceGitReadyResult =
  | {
      ok: true;
      fixesApplied: string[];
    }
  | {
      ok: false;
      reason: string;
      severity: WorkspaceGitBlockSeverity;
      fixesApplied: string[];
      conflictedPaths: string[];
      targets: string[];
    };

function normalizeTargetPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function resolveWorkspaceGitTargets(base: string): Promise<string[]> {
  const projectRoot = resolveWorktreeProjectRoot(base);
  const seen = new Set<string>();
  const targets: string[] = [];

  const addTarget = (path: string) => {
    if (!existsSync(path)) return;
    const normalized = normalizeTargetPath(path);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    targets.push(path);
  };

  addTarget(projectRoot);

  try {
    await ensureDbOpen(projectRoot);
    const state = await deriveState(projectRoot);
    if (state.activeMilestone) {
      const worktreePath = getAutoWorktreePath(projectRoot, state.activeMilestone.id);
      if (worktreePath) {
        addTarget(worktreePath);
      }
    }
  } catch {
    // Non-fatal — project root probe still runs.
  }

  return targets;
}

function productConflictPaths(probe: GitConflictProbeResult): string[] {
  return probe.unmerged.filter((path) => !isSafeToAutoResolve(path));
}

function formatBlockReason(
  severity: WorkspaceGitBlockSeverity,
  conflictedPaths: string[],
  targets: string[],
): string {
  const pathList = conflictedPaths.map((path) => `  - ${path}`).join("\n");
  const targetList = targets.join(", ");

  if (severity === "unrecoverable") {
    return [
      "Cannot verify Git conflict state (probe failed). Resolve Git/worktree state manually before continuing.",
      "",
      `Checked: ${targetList}`,
      "",
      "Fix:",
      "  1. Run /gsd doctor to inspect and repair git state.",
      "  2. Confirm `git status` works in the project root and active worktree.",
      "  3. Retry the command.",
    ].join("\n");
  }

  return [
    "Unresolved product Git conflicts remain after automatic recovery.",
    "",
    `Checked: ${targetList}`,
    "Conflicted paths:",
    pathList || "  (none listed)",
    "",
    "Fix:",
    "  1. Resolve conflict markers in the listed files and stage the resolutions.",
    "  2. Run /gsd doctor to verify git health.",
    "  3. Retry the command.",
  ].join("\n");
}

async function ensureTargetGitReady(target: string): Promise<WorkspaceGitReadyResult> {
  const fixesApplied: string[] = [];
  let probe = probeGitConflictState(target);

  for (let attempt = 0; attempt < 3 && probe.status === "dirty"; attempt++) {
    const beforeKey = JSON.stringify({
      unmerged: probe.unmerged,
      checkFailures: probe.checkFailures,
      mergeStateBlockers: probe.mergeStateBlockers,
    });
    fixesApplied.push(...reconcileGitConflictsOnSignal(target, probe));
    probe = probeGitConflictState(target);
    const afterKey = JSON.stringify({
      unmerged: probe.unmerged,
      checkFailures: probe.checkFailures,
      mergeStateBlockers: probe.mergeStateBlockers,
    });
    if (beforeKey === afterKey) break;
  }

  if (probe.status === "unknown") {
    return {
      ok: false,
      reason: formatBlockReason("unrecoverable", [], [target]),
      severity: "unrecoverable",
      fixesApplied,
      conflictedPaths: [],
      targets: [target],
    };
  }

  const conflictedPaths = productConflictPaths(probe);
  if (conflictedPaths.length > 0 || probe.checkFailures.length > 0) {
    return {
      ok: false,
      reason: formatBlockReason("product-conflicts", conflictedPaths, [target]),
      severity: "product-conflicts",
      fixesApplied,
      conflictedPaths,
      targets: [target],
    };
  }

  return { ok: true, fixesApplied };
}

/** Probe and heal a single git root (tests and headless paths). */
export async function ensureWorkspaceGitReadyForPath(
  target: string,
): Promise<WorkspaceGitReadyResult> {
  const result = await ensureTargetGitReady(target);
  if (!result.ok) {
    return {
      ...result,
      reason: formatBlockReason(result.severity, result.conflictedPaths, [target]),
      targets: [target],
    };
  }
  return result;
}

export async function ensureWorkspaceGitReady(base: string): Promise<WorkspaceGitReadyResult> {
  const targets = await resolveWorkspaceGitTargets(base);
  const fixesApplied: string[] = [];

  for (const target of targets) {
    const result = await ensureTargetGitReady(target);
    fixesApplied.push(...result.fixesApplied);
    if (!result.ok) {
      return {
        ...result,
        fixesApplied,
        targets,
        reason: formatBlockReason(result.severity, result.conflictedPaths, targets),
      };
    }
  }

  return { ok: true, fixesApplied };
}
