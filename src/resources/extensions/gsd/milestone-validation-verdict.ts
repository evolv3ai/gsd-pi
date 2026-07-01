// Project/App: gsd-pi
// File Purpose: Resolve the authoritative milestone validation verdict across DB and disk projections.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveExpectedArtifactPath } from "./auto-artifact-paths.js";
import { loadFile } from "./files.js";
import { getLatestAssessmentByScope, isDbAvailable } from "./gsd-db.js";
import { relMilestoneFile } from "./paths.js";
import {
  extractVerdict,
  isValidMilestoneVerdict,
  type ValidationVerdict,
} from "./verdict-parser.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";

function verdictFromContent(content: string | null | undefined): ValidationVerdict | undefined {
  if (!content) return undefined;
  const verdict = extractVerdict(content);
  return verdict && isValidMilestoneVerdict(verdict) ? verdict : undefined;
}

function verdictFromDb(milestoneId: string): ValidationVerdict | undefined {
  if (!isDbAvailable()) return undefined;
  const assessment = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  const status = typeof assessment?.status === "string" ? assessment.status : undefined;
  return status && isValidMilestoneVerdict(status) ? status : undefined;
}

async function verdictFromValidationPath(path: string | null): Promise<ValidationVerdict | undefined> {
  if (!path || !existsSync(path)) return undefined;
  return verdictFromContent(await loadFile(path));
}

/**
 * Resolve the milestone validation verdict using the same authority order as
 * DB-backed state derivation, with filesystem fallbacks that mirror
 * `resolveExpectedArtifactPath` (canonical worktree projection, then project
 * root). Manual `/gsd verdict` overrides persist to the DB first; a stale
 * worktree-local VALIDATION.md must not re-block auto-mode after the override.
 */
export async function resolveMilestoneValidationVerdict(
  basePath: string,
  milestoneId: string,
): Promise<ValidationVerdict | undefined> {
  const dbVerdict = verdictFromDb(milestoneId);
  if (dbVerdict) return dbVerdict;

  const canonicalBase = resolveCanonicalMilestoneRoot(basePath, milestoneId);
  const canonicalPath = resolveExpectedArtifactPath(
    "validate-milestone",
    milestoneId,
    canonicalBase,
  );
  const canonicalVerdict = await verdictFromValidationPath(canonicalPath);
  if (canonicalVerdict) return canonicalVerdict;

  const projectRoot = resolveWorktreeProjectRoot(basePath);
  if (projectRoot !== canonicalBase) {
    const projectPath = resolveExpectedArtifactPath(
      "validate-milestone",
      milestoneId,
      projectRoot,
    );
    const projectVerdict = await verdictFromValidationPath(projectPath);
    if (projectVerdict) return projectVerdict;
  }

  // Last resort: layout-aware fallback path when resolveDir helpers
  // haven't materialized the milestone directory yet. relMilestoneFile()
  // builds the canonical NN-VALIDATION.md path for flat-phase and the
  // legacy MID-VALIDATION.md path for projects that haven't migrated.
  // See open-gsd/gsd-pi#876.
  const directPath = join(canonicalBase, relMilestoneFile(canonicalBase, milestoneId, "VALIDATION"));
  return verdictFromValidationPath(directPath);
}
