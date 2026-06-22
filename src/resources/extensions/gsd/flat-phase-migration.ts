// Project/App: gsd-pi
// File Purpose: One-time migration from legacy nested .gsd/milestones/ to
// flat-phase .gsd/phases/. Runs on startup when the legacy structure is detected.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { renderAllFromDb } from "./markdown-renderer.js";
import { getAllMilestones } from "./gsd-db.js";
import { logWarning } from "./workflow-logger.js";
import { LAYOUT_SEGMENTS } from "./layout-policy.js";

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

  // 1. Backup
  try {
    mkdirSync(join(basePath, ".gsd-backups"), { recursive: true });
    cpSync(milestonesPath, backupDir, { recursive: true });
  } catch (err) {
    logWarning("migration", `flat-phase migration backup failed: ${(err as Error).message}`);
    throw err;
  }

  // 2. Render flat-phase from DB
  const milestonesBefore = getAllMilestones().length;
  const phasesPath = join(basePath, ".gsd", LAYOUT_SEGMENTS.level1);
  let renderResult: { rendered: number; skipped: number; errors: string[] };
  try {
    renderResult = await renderAllFromDb(basePath);
  } catch (err) {
    logWarning("migration", `flat-phase render failed: ${(err as Error).message}`);
    // Restore from backup on failure — remove partial phases/ dir
    rmSync(phasesPath, { recursive: true, force: true });
    throw err;
  }

  // 3. Verify: no render errors and phases/ contains the expected number of dirs.
  // (getAllMilestones() is unchanged by rendering — always use the disk count.)
  if (renderResult.errors.length > 0) {
    logWarning("migration", `flat-phase render errors: ${renderResult.errors.join("; ")}`);
    rmSync(phasesPath, { recursive: true, force: true });
    throw new Error(`flat-phase migration render failed with ${renderResult.errors.length} error(s): ${renderResult.errors[0]}`);
  }
  let renderedDirCount = 0;
  try {
    renderedDirCount = readdirSync(phasesPath, { withFileTypes: true })
      .filter(d => d.isDirectory()).length;
  } catch {
    // phases/ doesn't exist or is unreadable — same as zero dirs
  }
  if (milestonesBefore > 0 && renderedDirCount !== milestonesBefore) {
    logWarning("migration", `phases/ dir count mismatch: expected ${milestonesBefore}, found ${renderedDirCount}`);
    rmSync(phasesPath, { recursive: true, force: true });
    throw new Error("flat-phase migration verification failed: phases dir milestone count mismatch");
  }

  // 4. Remove old tree (backup exists; phases/ is verified written)
  try {
    rmSync(milestonesPath, { recursive: true, force: true });
  } catch (err) {
    logWarning("migration", `failed to remove legacy milestones/: ${(err as Error).message}`);
    // Non-fatal: the backup exists and phases/ is written; user can clean up manually.
  }
}
