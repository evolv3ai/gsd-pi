// gsd-pi + Workspace handle: single source of truth for path resolution per milestone

import { join, resolve } from "node:path";
import { type GsdPathContract, resolveGsdPathContract, normalizeRealPath, resolveMilestoneFile, resolveMilestonePath } from "./paths.js";
import { isGsdWorktreePath, resolveWorktreeProjectRoot } from "./worktree-root.js";

export type GsdWorkspaceMode = "project" | "worktree";

export interface GsdWorkspace {
  readonly projectRoot: string;          // realpath-normalized absolute
  readonly worktreeRoot: string | null;  // realpath-normalized absolute, null when no worktree
  readonly mode: GsdWorkspaceMode;
  readonly contract: GsdPathContract;    // pre-resolved, frozen
  readonly identityKey: string;          // canonical key (realpath of projectRoot) for dedup/cache
  readonly lockRoot: string;             // where auto.lock and {MID}-META.json live (always projectRoot)
}

export interface MilestoneScope {
  readonly workspace: GsdWorkspace;
  readonly milestoneId: string;
  // path methods:
  readonly contextFile: () => string;
  readonly roadmapFile: () => string;
  readonly stateFile: () => string;
  readonly dbPath: () => string;
  readonly milestoneDir: () => string;
  readonly metaJson: () => string;       // {MID}-META.json on lockRoot
}

function tryRealpath(p: string): string {
  return normalizeRealPath(p);
}

/**
 * Create an immutable GsdWorkspace handle from a raw base path.
 * Resolves both the project root and (when applicable) the worktree root,
 * normalizes them via realpath, and freezes the result.
 */
export function createWorkspace(rawBasePath: string): GsdWorkspace {
  const resolvedBase = resolve(rawBasePath);
  const isWorktree = isGsdWorktreePath(resolvedBase);

  const projectRootRaw = resolveWorktreeProjectRoot(resolvedBase);
  const projectRoot = tryRealpath(resolve(projectRootRaw));

  const worktreeRoot = isWorktree ? tryRealpath(resolvedBase) : null;

  // Derive a canonical base from the already-realpath-normalized paths so that
  // resolveGsdPathContract always receives a canonical path. Using the raw
  // resolvedBase here can produce a non-canonical projectGsd when the input
  // path contains symlinks, causing contract.projectGsd to diverge from the
  // realpath-normalized projectRoot / identityKey.
  const canonicalBase = isWorktree ? (worktreeRoot ?? resolvedBase) : projectRoot;
  const contract = Object.freeze(resolveGsdPathContract(canonicalBase));

  const identityKey = tryRealpath(projectRoot);

  const mode: GsdWorkspaceMode = isWorktree ? "worktree" : "project";

  const workspace: GsdWorkspace = Object.freeze({
    projectRoot,
    worktreeRoot,
    mode,
    contract,
    identityKey,
    lockRoot: projectRoot,
  });

  return workspace;
}

/**
 * Bind a milestoneId to a workspace, producing an immutable MilestoneScope
 * with path-returning closures for DB-authoritative project state.
 *
 * These scope paths intentionally route to contract.projectGsd. In-flight
 * markdown artifact readers outside this scope use the projection-aware
 * resolvers in paths.ts so worktree units can see worktree-local projections.
 */
export function scopeMilestone(workspace: GsdWorkspace, milestoneId: string): MilestoneScope {
  const { contract } = workspace;
  const gsd = contract.projectGsd;

  // Legacy path builders — returned when the file/dir doesn't exist on disk yet
  // (e.g. before the discuss unit runs). Once the discuss unit creates the files
  // in the flat-phase layout, the layout-aware resolvers below find them instead.
  const legacyContextFile = join(gsd, "milestones", milestoneId, `${milestoneId}-CONTEXT.md`);
  const legacyRoadmapFile = join(gsd, "milestones", milestoneId, `${milestoneId}-ROADMAP.md`);
  const legacyMilestoneDir = join(gsd, "milestones", milestoneId);

  const scope: MilestoneScope = Object.freeze({
    workspace,
    milestoneId,
    // Layout-aware: try the flat-phase resolver first; fall back to the legacy
    // path when the file/dir doesn't exist yet (preserves cwd-drift stability
    // because all paths are absolute regardless of which branch is taken).
    contextFile: () =>
      resolveMilestoneFile(workspace.projectRoot, milestoneId, "CONTEXT") ?? legacyContextFile,
    roadmapFile: () =>
      resolveMilestoneFile(workspace.projectRoot, milestoneId, "ROADMAP") ?? legacyRoadmapFile,
    milestoneDir: () =>
      resolveMilestonePath(workspace.projectRoot, milestoneId) ?? legacyMilestoneDir,
    stateFile: () => join(gsd, "STATE.md"),
    dbPath: () => contract.projectDb,
    metaJson: () => join(gsd, `${milestoneId}-META.json`),
  });

  return scope;
}
