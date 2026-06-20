// Project/App: gsd-pi
// File Purpose: Detect and reconcile unresolved Git conflict state before automation runs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { autoResolveSafeConflictPaths } from "./git-conflict-resolve.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { abortAndReset } from "./git-self-heal.js";
import { logWarning } from "./workflow-logger.js";

function splitZeroDelimited(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function hasGitMarker(basePath: string): boolean {
  try {
    let dir = resolve(basePath);
    for (let i = 0; i < 30; i++) {
      if (existsSync(join(dir, ".git"))) return true;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the git probes, which will report unknown on failure.
  }
  return false;
}

export function listUnmergedGitPaths(basePath: string): string[] | null {
  try {
    const output = spawnSync("git", ["diff", "--name-only", "--diff-filter=U", "-z"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    });
    if (output.status !== 0) {
      return null;
    }
    return [...new Set(splitZeroDelimited(output.stdout ?? ""))].sort();
  } catch {
    return null;
  }
}

export function gitDiffCheckFailures(basePath: string): string[] | null {
  const failures: string[] = [];

  for (const args of [["--cached"], []] as const) {
    const result = spawnSync("git", ["diff", "--check", ...args], {
      cwd: basePath,
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    });
    if (result.status === 0) continue;
    if (result.error) {
      return null;
    }

    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    // git diff --check exits non-zero for both whitespace errors and leftover
    // conflict markers. Only conflict markers block the gate — whitespace errors
    // in staged files (common in auto-generated code) must not be misread as an
    // unresolved merge conflict. Filter to lines git explicitly labels as
    // "leftover conflict marker".
    if (!output) {
      failures.push(`git diff --check ${args.join(" ")} failed`);
      continue;
    }
    const conflictMarkerLines = output
      .split("\n")
      .filter((line) => /leftover conflict marker/i.test(line))
      .join("\n");
    if (conflictMarkerLines) {
      failures.push(conflictMarkerLines);
    }
  }

  return failures;
}

const MERGE_STATE_MARKERS = ["MERGE_HEAD", "rebase-apply", "rebase-merge"] as const;

export function listMergeStateBlockers(basePath: string): string[] {
  const gitDir = join(basePath, ".git");
  if (!existsSync(gitDir)) {
    return [];
  }
  return MERGE_STATE_MARKERS.filter((marker) => existsSync(join(gitDir, marker)));
}

export type GitConflictProbeStatus = "clean" | "dirty" | "unknown";

export interface GitConflictProbeResult {
  status: GitConflictProbeStatus;
  unmerged: string[];
  checkFailures: string[];
  mergeStateBlockers: string[];
}

export function probeGitConflictState(basePath: string): GitConflictProbeResult {
  if (!hasGitMarker(basePath)) {
    return {
      status: "clean",
      unmerged: [],
      checkFailures: [],
      mergeStateBlockers: [],
    };
  }

  const unmerged = listUnmergedGitPaths(basePath);
  if (unmerged === null) {
    return {
      status: "unknown",
      unmerged: [],
      checkFailures: [],
      mergeStateBlockers: [],
    };
  }

  const checkFailures = gitDiffCheckFailures(basePath);
  if (checkFailures === null) {
    return {
      status: "unknown",
      unmerged,
      checkFailures: [],
      mergeStateBlockers: [],
    };
  }

  const mergeStateBlockers = listMergeStateBlockers(basePath);
  const dirty =
    unmerged.length > 0 ||
    checkFailures.length > 0 ||
    mergeStateBlockers.length > 0;

  return {
    status: dirty ? "dirty" : "clean",
    unmerged,
    checkFailures,
    mergeStateBlockers,
  };
}

export function reconcileGitConflictsOnSignal(
  basePath: string,
  probe: GitConflictProbeResult,
): string[] {
  const fixesApplied: string[] = [];

  if (
    probe.mergeStateBlockers.length > 0 &&
    probe.unmerged.length === 0
  ) {
    try {
      const result = abortAndReset(basePath);
      fixesApplied.push(
        `aborted stale merge/rebase state (${result.cleaned.join(", ") || "reset"})`,
      );
    } catch (err) {
      logWarning(
        "reconcile",
        `abortAndReset failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (probe.unmerged.length > 0) {
    const { resolved } = autoResolveSafeConflictPaths(basePath, probe.unmerged);
    if (resolved.length > 0) {
      fixesApplied.push(`auto-resolved safe conflicts: ${resolved.join(", ")}`);
    }
    const refreshed = probeGitConflictState(basePath);
    if (
      refreshed.mergeStateBlockers.length > 0 &&
      refreshed.unmerged.length === 0
    ) {
      try {
        const result = abortAndReset(basePath);
        fixesApplied.push(
          `cleared merge state after safe auto-resolve (${result.cleaned.join(", ") || "reset"})`,
        );
      } catch (err) {
        logWarning(
          "reconcile",
          `abortAndReset after auto-resolve failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return fixesApplied;
}
