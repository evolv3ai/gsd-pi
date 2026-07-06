import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { createRepositoryRegistryFromPreferences } from "./repository-registry.js";

import type { DoctorIssue } from "./doctor-types.js";
import type { GSDPreferences } from "./preferences.js";

/**
 * Resolve the git working-tree root for a path, or null if it is not a repo.
 * Used by the workspace-repository probe to check that a declared child path is
 * itself a git repository (not merely nested inside the parent's repo).
 */
function resolveGitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    }).trim();
    return out ? resolve(out) : null;
  } catch {
    return null;
  }
}

/** realpath that falls back to the resolved path if the link cannot be read. */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Parent-workspace probe (#818): validate that every declared child repository
 * exists on disk and is a git repository at its own root. The registry only
 * checks paths stay inside the project root; it never checks existence or
 * git-ness, so a typo'd path (e.g. `frontned`) would otherwise build cleanly
 * and silently produce "no problems found." No-op for single-repo projects.
 */
export function checkWorkspaceRepositoryHealth(
  basePath: string,
  prefs: GSDPreferences | undefined,
  issues: DoctorIssue[],
): void {
  if (prefs?.workspace?.mode !== "parent") return;
  let registry;
  try {
    registry = createRepositoryRegistryFromPreferences(basePath, prefs);
  } catch (err) {
    issues.push({
      severity: "error",
      code: "invalid_preferences",
      scope: "project",
      unitId: "workspace",
      message: `workspace registry failed to build: ${err instanceof Error ? err.message : String(err)}`,
      fixable: false,
    });
    return;
  }
  for (const repo of registry.repositories) {
    if (repo.id === "project") continue;
    if (!existsSync(repo.root)) {
      issues.push({
        severity: "error",
        code: "workspace_repo_path_missing",
        scope: "project",
        unitId: `workspace.repositories.${repo.id}`,
        message: `declared repository "${repo.id}" path does not exist on disk: ${repo.root}`,
        fixable: false,
      });
      continue;
    }
    // Must be a repo at its OWN root — a plain dir nested in the parent repo
    // would otherwise pass a bare `nativeIsRepo` check via the enclosing
    // parent's .git. Compare on realpath so symlinked temp roots (macOS
    // /var vs /private/var) don't cause a false mismatch.
    const toplevel = resolveGitToplevel(repo.root);
    const declaredReal = realpathSafe(repo.root);
    const toplevelReal = toplevel ? realpathSafe(toplevel) : null;
    if (toplevelReal !== declaredReal) {
      issues.push({
        severity: "warning",
        code: "workspace_repo_not_a_repo",
        scope: "project",
        unitId: `workspace.repositories.${repo.id}`,
        message: `declared repository "${repo.id}" path is not a git repository at its own root: ${repo.root}`,
        fixable: false,
      });
    }
  }
}
