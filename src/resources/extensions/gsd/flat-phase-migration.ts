// Project/App: gsd-pi
// File Purpose: One-time migration from legacy nested .gsd/milestones/ to
// flat-phase .gsd/phases/. Runs on startup when the legacy structure is detected.

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderAllFromDb, renderRoadmapFromDb } from "./markdown-renderer.js";
import { getAllMilestones, getMilestoneSlices } from "./gsd-db.js";
import { migrateFromMarkdown } from "./md-importer.js";
import { countDbHierarchy } from "./migration-auto-check.js";
import { logWarning } from "./workflow-logger.js";
import { LAYOUT_SEGMENTS } from "./layout-policy.js";
import { canonicalPhaseDirName, milestonesDir, resolveMilestonePath } from "./paths.js";

const LEGACY_MIGRATING_SEGMENT = "milestones.migrating";

function legacyMigratingPath(basePath: string): string {
  return join(basePath, ".gsd", LEGACY_MIGRATING_SEGMENT);
}

function hasLegacyMilestoneSubdirs(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  try {
    return readdirSync(dirPath).some(e => statSync(join(dirPath, e)).isDirectory());
  } catch {
    return false;
  }
}

function rollbackPartialMigration(
  basePath: string,
  backupDir: string,
  migratingPath?: string,
): void {
  // Remove the partially-written phases/ dir.
  rmSync(join(basePath, ".gsd", LAYOUT_SEGMENTS.level1), { recursive: true, force: true });
  // Restore milestones/ — prefer renaming the preserved migrating copy back.
  const milestonesPath = join(basePath, ".gsd", "milestones");
  try {
    if (migratingPath && existsSync(migratingPath) && !existsSync(milestonesPath)) {
      renameSync(migratingPath, milestonesPath);
      return;
    }
    if (existsSync(backupDir)) {
      cpSync(backupDir, milestonesPath, { recursive: true });
    }
    if (migratingPath && existsSync(migratingPath)) {
      rmSync(migratingPath, { recursive: true, force: true });
    }
  } catch (restoreErr) {
    logWarning(
      "migration",
      `rollback: could not restore milestones/: ${(restoreErr as Error).message}`,
    );
    // Non-fatal: backup still exists at backupDir for manual recovery.
  }
}

/**
 * Detect whether the project uses the legacy nested layout.
 * True when .gsd/milestones/ exists AND contains at least one milestone
 * subdirectory. An empty milestones/ dir (created by old bootstrap code
 * before it was fixed) is not a real legacy layout and must not trigger
 * a migration that would thrash the reconciler.
 */
export function needsFlatPhaseMigration(basePath: string): boolean {
  if (hasLegacyMilestoneSubdirs(join(basePath, ".gsd", "milestones"))) return true;
  // Resume an interrupted migration where the legacy tree was renamed aside.
  return hasLegacyMilestoneSubdirs(legacyMigratingPath(basePath));
}

/** Retention window before flat-phase migration backups are auto-pruned. */
export const FLAT_PHASE_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remove stale flat-phase migration backups after the retention window.
 * Only runs when migration is complete (.gsd/phases/ exists, legacy layout gone).
 * Returns the number of migrate-* directories removed.
 */
export function pruneStaleFlatPhaseBackups(basePath: string): number {
  if (needsFlatPhaseMigration(basePath)) return 0;

  const phasesPath = join(basePath, ".gsd", LAYOUT_SEGMENTS.level1);
  if (!existsSync(phasesPath)) return 0;

  const backupRoot = join(basePath, ".gsd-backups");
  if (!existsSync(backupRoot)) return 0;

  const now = Date.now();
  let removed = 0;
  for (const entry of readdirSync(backupRoot)) {
    if (!entry.startsWith("migrate-")) continue;
    const dirPath = join(backupRoot, entry);
    try {
      const st = statSync(dirPath);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < FLAT_PHASE_BACKUP_RETENTION_MS) continue;
      rmSync(dirPath, { recursive: true, force: true });
      removed++;
    } catch {
      // Non-fatal: leave backup for manual recovery.
    }
  }

  try {
    if (readdirSync(backupRoot).length === 0) {
      rmSync(backupRoot, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal.
  }

  return removed;
}

/**
 * Migrate from legacy nested .gsd/milestones/ to flat-phase .gsd/phases/.
 *
 * Steps:
 * 1. Backup .gsd/milestones/ to .gsd-backups/migrate-<ts>/
 * 2. Rename .gsd/milestones/ aside so path resolvers target phases/
 * 3. Render flat-phase from the DB (which already has the data)
 * 4. Verify counts match
 * 5. Remove the renamed legacy tree
 *
 * Idempotent: if .gsd/milestones/ doesn't exist, returns immediately.
 */
export async function migrateToFlatPhase(basePath: string): Promise<void> {
  if (!needsFlatPhaseMigration(basePath)) return;

  const milestonesPath = join(basePath, ".gsd", "milestones");
  const migratingPath = legacyMigratingPath(basePath);
  const phasesPath = join(basePath, ".gsd", LAYOUT_SEGMENTS.level1);
  const resumingInterrupted =
    !hasLegacyMilestoneSubdirs(milestonesPath) && hasLegacyMilestoneSubdirs(migratingPath);

  // 1. Reconcile DB from legacy markdown before backup/removal so on-disk-only
  // content is imported even when milestone rows already exist in SQLite.
  // Check BEFORE creating the backup — avoids accumulating .gsd-backups/ entries
  // on every session start when milestones/ exists but the DB has no rows.
  migrateFromMarkdown(basePath);
  const milestonesBefore = getAllMilestones().length;
  if (milestonesBefore === 0) {
    logWarning(
      "migration",
      "flat-phase migration skipped: legacy milestones/ exists but DB has no milestone rows — will retry when DB is populated",
    );
    return;
  }

  let backupDir = migratingPath;
  if (!resumingInterrupted) {
    // 2. Backup (only reached when the DB has rows and migration will proceed)
    const ts = Date.now();
    backupDir = join(basePath, ".gsd-backups", `migrate-${ts}`);
    try {
      mkdirSync(join(basePath, ".gsd-backups"), { recursive: true });
      cpSync(milestonesPath, backupDir, { recursive: true });
    } catch (err) {
      logWarning("migration", `flat-phase migration backup failed: ${(err as Error).message}`);
      throw err;
    }

    // 3. Rename legacy tree aside before rendering so path resolvers target
    // phases/ instead of writing back into the nested milestones/ layout.
    // Keep the full tree on disk until render+verify succeed (unlike rmSync).
    try {
      renameSync(milestonesPath, migratingPath);
    } catch (err) {
      logWarning("migration", `failed to rename legacy milestones/ before render: ${(err as Error).message}`);
      throw err;
    }
  } else {
    // Interrupted run: clear any partial phases/ projection before retrying.
    rmSync(phasesPath, { recursive: true, force: true });
  }

  // 4. Render flat-phase from DB
  let renderResult: { rendered: number; skipped: number; errors: string[] };
  try {
    renderResult = await renderAllFromDb(basePath);
    // Slice-less milestones still need a phase directory for flat-phase layout.
    for (const milestone of getAllMilestones()) {
      if (getMilestoneSlices(milestone.id).length > 0) continue;
      const roadmapResult = await renderRoadmapFromDb(basePath, milestone.id);
      if ("skipped" in roadmapResult) {
        const phaseDir = resolveMilestonePath(basePath, milestone.id) ??
          join(milestonesDir(basePath), canonicalPhaseDirName(milestone.id, milestone.title));
        mkdirSync(phaseDir, { recursive: true });
        continue;
      }
      renderResult.rendered++;
    }
  } catch (err) {
    logWarning("migration", `flat-phase render failed: ${(err as Error).message}`);
    rollbackPartialMigration(basePath, backupDir, migratingPath);
    throw err;
  }

  // 5. Verify render succeeded and flat-phase projection was written
  if (renderResult.errors.length > 0) {
    logWarning(
      "migration",
      `flat-phase render had ${renderResult.errors.length} error(s): ${renderResult.errors.join("; ")}`,
    );
    rollbackPartialMigration(basePath, backupDir, migratingPath);
    throw new Error(
      `flat-phase migration render failed: ${renderResult.errors.slice(0, 3).join("; ")}`,
    );
  }

  const db = countDbHierarchy();
  let renderedDirCount = 0;
  try {
    // /^\d+-/ matches any numeric prefix (01-, 10-, 100-) so M100+ milestones
    // whose dirs start with "100-slug" are counted correctly.
    renderedDirCount = readdirSync(phasesPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+-/.test(entry.name)).length;
  } catch {
    // phases/ doesn't exist or is unreadable — same as zero dirs
  }
  if (db.milestones > 0 && renderedDirCount !== db.milestones) {
    logWarning(
      "migration",
      `phases/ dir count mismatch: expected ${db.milestones}, found ${renderedDirCount}`,
    );
    rollbackPartialMigration(basePath, backupDir, migratingPath);
    throw new Error("flat-phase migration verification failed: phases dir milestone count mismatch");
  }
  if (db.slices > 0 && renderResult.rendered === 0) {
    logWarning(
      "migration",
      "flat-phase migration verification failed: render produced no artifacts for populated DB",
    );
    rollbackPartialMigration(basePath, backupDir, migratingPath);
    throw new Error("flat-phase migration verification failed: no artifacts rendered");
  }

  // 6. Verified — remove the renamed legacy tree (backup already on disk).
  try {
    rmSync(migratingPath, { recursive: true, force: true });
  } catch (err) {
    logWarning(
      "migration",
      `flat-phase migration succeeded but could not remove ${LEGACY_MIGRATING_SEGMENT}: ${(err as Error).message}`,
    );
  }
}
