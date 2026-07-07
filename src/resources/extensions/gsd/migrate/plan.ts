// gsd-pi - /gsd migrate planning service.
// File Purpose: Resolve, validate, parse, transform, preview, and guard a migration before UI confirmation.

import { existsSync } from "node:fs";

import {
  assertMigrationHasSlices,
  assertMigrationTargetAvailable,
  resolveMigrationPaths,
  type MigrationPaths,
} from "./safety.js";
import { parsePlanningDirectory } from "./parser.js";
import { generatePreview } from "./preview.js";
import { transformToGSD } from "./transformer.js";
import { validatePlanningDirectory } from "./validator.js";
import type { GSDProject, ValidationIssue, ValidationResult } from "./types.js";
import type { MigrationPreview } from "./writer.js";

export interface SplitValidationIssues {
  warnings: ValidationIssue[];
  fatals: ValidationIssue[];
}

interface MigrationPlanBase extends MigrationPaths {
  warnings: ValidationIssue[];
  fatals: ValidationIssue[];
}

export interface MissingMigrationSourceResult extends MigrationPaths {
  status: "missing-source";
}

export interface InvalidMigrationPlanResult extends MigrationPlanBase {
  status: "invalid";
  validation: ValidationResult;
}

export interface BlockedMigrationPlanResult extends MigrationPlanBase {
  status: "blocked";
  validation: ValidationResult;
  message: string;
}

export interface ReadyMigrationPlanResult extends MigrationPlanBase {
  status: "ready";
  validation: ValidationResult;
  project: GSDProject;
  preview: MigrationPreview;
}

export type MigrationPlanResult =
  | MissingMigrationSourceResult
  | InvalidMigrationPlanResult
  | BlockedMigrationPlanResult
  | ReadyMigrationPlanResult;

export function splitValidationIssues(validation: ValidationResult): SplitValidationIssues {
  return {
    warnings: validation.issues.filter((issue) => issue.severity === "warning"),
    fatals: validation.issues.filter((issue) => issue.severity === "fatal"),
  };
}

export async function createMigrationPlan(args: string, cwd: string = process.cwd()): Promise<MigrationPlanResult> {
  const paths = resolveMigrationPaths(args, cwd);
  if (!existsSync(paths.sourcePath)) {
    return { status: "missing-source", ...paths };
  }

  const validation = await validatePlanningDirectory(paths.sourcePath);
  const issues = splitValidationIssues(validation);
  if (!validation.valid) {
    return { status: "invalid", ...paths, validation, ...issues };
  }

  const parsed = await parsePlanningDirectory(paths.sourcePath);
  const project = transformToGSD(parsed);
  const preview = generatePreview(project);

  try {
    assertMigrationHasSlices(preview);
    await assertMigrationTargetAvailable(paths.targetRoot);
  } catch (error) {
    return {
      status: "blocked",
      ...paths,
      validation,
      ...issues,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    status: "ready",
    ...paths,
    validation,
    ...issues,
    project,
    preview,
  };
}
