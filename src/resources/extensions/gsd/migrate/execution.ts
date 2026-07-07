// gsd-pi - /gsd migrate execution service.
// File Purpose: Write migrated .gsd files, import them into the DB, verify projection/readiness, and rollback on failure.

import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import { closeWorkflowDatabase } from "../db-workspace.js";
import { clearArtifacts, clearDecisions, clearEngineHierarchy, clearRequirements, transaction } from "../gsd-db.js";
import { migrateFromMarkdown } from "../md-importer.js";
import { deriveState, invalidateStateCache } from "../state.js";
import {
  archiveLegacyPlanningDirectory,
  verifyMigrationProjection,
  writeMigrationAudit,
  type LegacyArchiveResult,
  type MigrationAuditResult,
  type MigrationProjectionVerification,
} from "./audit.js";
import {
  prepareMigrationTarget,
  restoreMigrationTarget,
  type MigrationBackup,
} from "./safety.js";
import { writeGSDDirectory, type MigrationPreview, type WrittenFiles } from "./writer.js";
import type { GSDProject } from "./types.js";

export type MigrationImportCounts = ReturnType<typeof migrateFromMarkdown>;

export interface MigrationExecutionResult {
  backup: MigrationBackup;
  written: WrittenFiles;
  imported: MigrationImportCounts;
  legacyArchive: LegacyArchiveResult;
  verification: MigrationProjectionVerification;
  audit: MigrationAuditResult;
}

function assertMigrationImportMatchesPreview(imported: MigrationImportCounts, preview: MigrationPreview): void {
  const mismatches: string[] = [];
  if (imported.decisions !== preview.decisions.total) {
    mismatches.push(`decisions ${imported.decisions}/${preview.decisions.total}`);
  }
  if (imported.hierarchy.milestones !== preview.milestoneCount) {
    mismatches.push(`milestones ${imported.hierarchy.milestones}/${preview.milestoneCount}`);
  }
  if (imported.hierarchy.slices !== preview.totalSlices) {
    mismatches.push(`slices ${imported.hierarchy.slices}/${preview.totalSlices}`);
  }
  if (imported.hierarchy.tasks !== preview.totalTasks) {
    mismatches.push(`tasks ${imported.hierarchy.tasks}/${preview.totalTasks}`);
  }
  if (imported.requirements !== preview.requirements.total) {
    mismatches.push(`requirements ${imported.requirements}/${preview.requirements.total}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`migration DB import verification failed: ${mismatches.join(", ")}`);
  }
}

export async function importWrittenMigrationToDb(
  basePath: string,
  preview?: MigrationPreview,
): Promise<MigrationImportCounts> {
  const opened = await ensureDbOpen(basePath);
  if (!opened) {
    throw new Error(`failed to open or create the GSD database at ${basePath}`);
  }

  const counts = transaction(() => {
    clearEngineHierarchy();
    clearArtifacts();
    clearDecisions();
    clearRequirements();
    const imported = migrateFromMarkdown(basePath);
    if (preview) assertMigrationImportMatchesPreview(imported, preview);
    return imported;
  });
  invalidateStateCache();
  return counts;
}

export async function assertMigrationDbReadiness(
  targetRoot: string,
  preview: MigrationPreview,
): Promise<{ phase: string; registry: number }> {
  invalidateStateCache();
  const state = await deriveState(targetRoot);
  const dbUnavailable = state.blockers.some((blocker) => blocker.includes("DB unavailable"));
  if (dbUnavailable) {
    throw new Error(`migration DB readiness failed: ${state.blockers.join("; ")}`);
  }
  if (state.registry.length !== preview.milestoneCount) {
    throw new Error(`migration DB readiness failed: registry ${state.registry.length}/${preview.milestoneCount}`);
  }
  return {
    phase: state.phase,
    registry: state.registry.length,
  };
}

export async function executeMigrationWrite(
  sourcePath: string,
  targetRoot: string,
  project: GSDProject,
  preview: MigrationPreview,
  startedAt: string = new Date().toISOString(),
): Promise<MigrationExecutionResult> {
  const backup = prepareMigrationTarget(targetRoot);

  try {
    const written = await writeGSDDirectory(project, targetRoot);
    const legacyArchive = await archiveLegacyPlanningDirectory(sourcePath, targetRoot);
    const imported = await importWrittenMigrationToDb(targetRoot, preview);
    const verification = await verifyMigrationProjection(targetRoot, preview);
    verification.dbReadiness = await assertMigrationDbReadiness(targetRoot, preview);
    const audit = await writeMigrationAudit({
      sourcePath,
      targetRoot,
      backupPath: backup.backupPath,
      preview,
      written,
      imported,
      legacyArchive,
      verification,
      startedAt,
      completedAt: new Date().toISOString(),
    });

    return { backup, written, imported, legacyArchive, verification, audit };
  } catch (error) {
    // The import transaction may have committed and the process may hold an
    // open handle to the target gsd.db; close before the restore replaces the
    // file on disk, and leave closed so the next open rebinds to the restored file.
    try { closeWorkflowDatabase(); } catch { /* best-effort: restore must proceed */ }
    restoreMigrationTarget(backup);
    throw error;
  }
}
