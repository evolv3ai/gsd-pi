// Project/App: gsd-pi
// File Purpose: One-time migration from legacy nested .gsd/milestones/ to
// flat-phase .gsd/phases/. Runs on startup when the legacy structure is detected.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { renderAllFromDb } from "./markdown-renderer.js";
import { getAllMilestones } from "./gsd-db.js";
import { countDbHierarchy } from "./migration-auto-check.js";
import { logWarning } from "./workflow-logger.js";
import { LAYOUT_SEGMENTS } from "./layout-policy.js";

function rollbackPartialMigration(basePath: string, backupDir: string): void {
  // Remove the partially-written phases/ dir.
  rmSync(join(basePath, ".gsd", LAYOUT_SEGMENTS.level1), { recursive: true, force: true });
  // Restore milestones/ from backup — it was removed before render, so
  // a failed migration would otherwise leave the project with no hierarchy.
  const milestonesPath = join(basePath, ".gsd", "milestones");
  try {
    if (existsSync(backupDir)) {
      cpSync(backupDir, milestonesPath, { recursive: true });
    }
  } catch (restoreErr) {
    logWarning(
      "migration",
      `rollback: could not restore milestones/ from backup ${backupDir}: ${(restoreErr as Error).message}`,
    );
    // Non-fatal: backup still exists at backupDir for manual recovery.
  }
}

/**
 * Detect whether the project uses the legacy nested layout.
 * True when .gsd/milestones/ exists.
 */
export function needsFlatPhaseMigration(basePath: string): boolean {
  return existsSync(join(basePath, ".gsd", "milestones"));
}

/**
 * Migrate from legacy nested .gsd/milestones/ to flat-phase .gsd/phases/.
 *
 * Steps:
 * 1. Backup .gsd/milestones/ to .gsd-backups/migrate-<ts>/
 * 2. Render flat-phase from the DB (which already has the data)
 * 3. Verify counts match
 * 4. Remove .gsd/milestones/
 *
 * Idempotent: if .gsd/milestones/ doesn't exist, returns immediately.
 */
export async function migrateToFlatPhase(basePath: string): Promise<void> {
  if (!needsFlatPhaseMigration(basePath)) return;

  const ts = Date.now();
  const backupDir = join(basePath, ".gsd-backups", `migrate-${ts}`);
  const milestonesPath = join(basePath, ".gsd", "milestones");
  const phasesPath = join(basePath, ".gsd", LAYOUT_SEGMENTS.level1);

  // 1. Backup
  try {
    mkdirSync(join(basePath, ".gsd-backups"), { recursive: true });
    cpSync(milestonesPath, backupDir, { recursive: true });
  } catch (err) {
    logWarning("migration", `flat-phase migration backup failed: ${(err as Error).message}`);
    throw err;
  }

  // 2. Refuse when the DB has no milestone rows — legacy milestones/ is the
  // only on-disk hierarchy and must not be dropped without a projection.
  const milestonesBefore = getAllMilestones().length;
  if (milestonesBefore === 0) {
    logWarning(
      "migration",
      "flat-phase migration refused: legacy milestones/ exists but DB has no milestone rows",
    );
    throw new Error("flat-phase migration refused: no milestone data in DB");
  }

  // 3. Remove legacy tree before rendering so path resolvers target phases/
  // instead of writing back into the nested milestones/ layout.
  try {
    rmSync(milestonesPath, { recursive: true, force: true });
  } catch (err) {
    logWarning("migration", `failed to remove legacy milestones/ before render: ${(err as Error).message}`);
    throw err;
  }

  // 4. Render flat-phase from DB
  let renderResult: { rendered: number; skipped: number; errors: string[] };
  try {
    renderResult = await renderAllFromDb(basePath);
  } catch (err) {
    logWarning("migration", `flat-phase render failed: ${(err as Error).message}`);
    rollbackPartialMigration(basePath, backupDir);
    throw err;
  }

  // 5. Verify render succeeded and flat-phase projection was written
  if (renderResult.errors.length > 0) {
    logWarning(
      "migration",
      `flat-phase render had ${renderResult.errors.length} error(s): ${renderResult.errors.join("; ")}`,
    );
    rollbackPartialMigration(basePath, backupDir);
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
    rollbackPartialMigration(basePath, backupDir);
    throw new Error("flat-phase migration verification failed: phases dir milestone count mismatch");
  }
  if (db.slices > 0 && renderResult.rendered === 0) {
    logWarning(
      "migration",
      "flat-phase migration verification failed: render produced no artifacts for populated DB",
    );
    rollbackPartialMigration(basePath, backupDir);
    throw new Error("flat-phase migration verification failed: no artifacts rendered");
  }

  // Legacy milestones/ was removed before render; nothing further to clean up.
}
