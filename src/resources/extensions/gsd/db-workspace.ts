// Project/App: gsd-pi
// File Purpose: Workspace-facing Interface for opening and maintaining the workflow database.

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GsdWorkspace, MilestoneScope } from "./workspace.js";
import type { DbAdapter } from "./db-adapter.js";
import {
  checkpointDatabase,
  closeAllDatabases,
  closeDatabase,
  closeDatabaseByWorkspace,
  getDbPath,
  getDbStatus,
  getDbProvider,
  isDbAvailable,
  _getAdapter,
  openDatabase,
  openDatabaseByScope,
  openDatabaseByWorkspace,
  openIsolatedDatabase,
  refreshOpenDatabaseFromDisk,
  vacuumDatabase,
  wasDbOpenAttempted,
} from "./gsd-db.js";
import {
  applyLegacyImport,
  type LegacyImportApplicationReceipt,
} from "./legacy-import-application.js";
import {
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "./legacy-import-backup.js";
import { captureCurrentLegacyImportBaseSnapshot } from "./legacy-import-preview-base.js";
import {
  createLegacyImportPreview,
  type LegacyImportPreviewArtifact,
  type LegacyImportPreviewCreateInput,
} from "./legacy-import-preview.js";
import { drillLegacyImportBackupRestore } from "./legacy-import-restore-drill.js";
import { resolveGsdPathContract, gsdRoot } from "./paths.js";
import { logWarning, setLogBasePath } from "./workflow-logger.js";

export interface WorkflowDatabaseLocation {
  projectRoot: string;
  projectGsd: string;
  projectDb: string;
}

export type WorkflowDatabaseOpenReason =
  | "opened-existing"
  | "created-empty"
  | "missing-database"
  | "missing-gsd-dir"
  | "open-failed";

export type WorkflowDatabaseOpenResult =
  | {
      ok: true;
      reason: "opened-existing" | "created-empty";
      location: WorkflowDatabaseLocation;
    }
  | {
      ok: false;
      reason: "missing-database" | "missing-gsd-dir" | "open-failed";
      location: WorkflowDatabaseLocation;
      error?: Error;
    };

export type WorkflowDatabaseStatus = ReturnType<typeof getDbStatus>;
export type WorkflowDatabaseProvider = ReturnType<typeof getDbProvider>;

/**
 * Global SQLite handle invariants:
 *
 * - `openWorkflowDatabase` / `openDatabase` switch the process-global handle consumed by
 *   deriveState, dispatch, reconciliation repairs, and domain writers. Only one active
 *   project database should own the global handle at a time.
 * - `openWorkflowDatabaseIsolated` opens a caller-owned connection that does not clobber
 *   the global handle. Use for read-only observers (parallel monitor) and other background
 *   probes that must not disturb the active workflow session.
 * - Reconciliation repairs that write markdown/DB state must use `ensureWorkflowDbForBase`
 *   so repairs target the correct project; those paths intentionally re-open the global handle.
 * - Pair ad-hoc project switches with `closeWorkflowDatabase()` or restore via
 *   `ensureWorkflowDbForBase(..., { refresh: true })` before returning to derive/dispatch.
 */
export function resolveWorkflowDatabaseLocation(basePath: string): WorkflowDatabaseLocation {
  const contract = resolveGsdPathContract(basePath);
  return {
    projectRoot: dirname(dirname(contract.projectDb)),
    projectGsd: contract.projectGsd,
    projectDb: contract.projectDb,
  };
}

/**
 * Resolve the correct DB path for the current working directory.
 * If `basePath` is inside a `.gsd/worktrees/<MID>/` directory, returns
 * the project root's `.gsd/gsd.db` (shared WAL — R012). Otherwise returns
 * `<basePath>/.gsd/gsd.db`.
 */
export function resolveProjectRootDbPath(basePath: string): string {
  return resolveWorkflowDatabaseLocation(basePath).projectDb;
}

export function openWorkflowDatabase(basePath: string): WorkflowDatabaseOpenResult {
  const location = resolveWorkflowDatabaseLocation(basePath);
  if (!existsSync(location.projectGsd)) {
    return { ok: false, reason: "missing-gsd-dir", location };
  }

  const existed = existsSync(location.projectDb);
  try {
    const opened = openDatabase(location.projectDb);
    if (!opened) {
      return { ok: false, reason: "open-failed", location };
    }
    setLogBasePath(location.projectRoot);
    return {
      ok: true,
      reason: existed ? "opened-existing" : "created-empty",
      location,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "open-failed",
      location,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

export function openExistingWorkflowDatabase(basePath: string): WorkflowDatabaseOpenResult {
  const location = resolveWorkflowDatabaseLocation(basePath);
  if (!existsSync(location.projectDb)) {
    return { ok: false, reason: "missing-database", location };
  }
  return openWorkflowDatabase(basePath);
}

export function openWorkflowDatabasePath(path: string): boolean {
  return openDatabase(path);
}

/**
 * Open an isolated database connection for read-only observation without
 * displacing the active workflow session's global DB handle. The caller is
 * responsible for calling `adapter.close()` when done.
 *
 * Use this for background observers (e.g. the parallel monitor overlay) that
 * need to query a database on a 5s tick without interfering with the primary
 * connection. Returns null if the connection cannot be opened.
 */
export function openWorkflowDatabaseIsolated(path: string): DbAdapter | null {
  return openIsolatedDatabase(path);
}

export function openWorkflowDatabaseByWorkspace(workspace: GsdWorkspace): boolean {
  return openDatabaseByWorkspace(workspace);
}

export function openWorkflowDatabaseByScope(scope: MilestoneScope): boolean {
  return openDatabaseByScope(scope);
}

export function closeWorkflowDatabase(): void {
  closeDatabase();
}

export function closeWorkflowDatabaseByWorkspace(workspace: GsdWorkspace): void {
  closeDatabaseByWorkspace(workspace);
}

export function closeAllWorkflowDatabases(): void {
  closeAllDatabases();
}

export function isWorkflowDatabaseOpen(): boolean {
  return isDbAvailable();
}

export function wasWorkflowDatabaseOpenAttempted(): boolean {
  return wasDbOpenAttempted();
}

export function getWorkflowDatabaseStatus(): WorkflowDatabaseStatus {
  return getDbStatus();
}

export function getWorkflowDatabaseProvider(): WorkflowDatabaseProvider {
  return getDbProvider();
}

export function getWorkflowDatabasePath(): string | null {
  return getDbPath();
}

export function refreshWorkflowDatabaseFromDisk(): boolean {
  return refreshOpenDatabaseFromDisk();
}

export function expectedWorkflowDbPathForBase(basePath: string): string {
  return join(gsdRoot(basePath), "gsd.db");
}

export interface EnsureWorkflowDbOptions {
  /** When true, refresh from disk before reopening if already open on the correct path. */
  refresh?: boolean;
}

export function ensureWorkflowDbAtPath(dbPath: string | null): boolean {
  if (!dbPath || dbPath === ":memory:") return isDbAvailable();
  if (isDbAvailable() && getWorkflowDatabasePath() === dbPath) return true;
  if (!existsSync(dbPath)) return false;
  try {
    return openWorkflowDatabasePath(dbPath);
  } catch (err) {
    logWarning("reconcile", `ensureWorkflowDbAtPath could not reopen DB: ${(err as Error).message}`);
    return false;
  }
}

export function ensureWorkflowDbForBase(
  basePath: string,
  options: EnsureWorkflowDbOptions = {},
): boolean {
  const dbPath = expectedWorkflowDbPathForBase(basePath);
  if (!existsSync(dbPath)) return false;

  try {
    if (options.refresh) {
      if (isDbAvailable() && getWorkflowDatabasePath() === dbPath && refreshWorkflowDatabaseFromDisk()) {
        return true;
      }
      return openWorkflowDatabasePath(dbPath);
    }

    if (isDbAvailable() && getWorkflowDatabasePath() === dbPath) return true;
    return openWorkflowDatabasePath(dbPath);
  } catch (err) {
    logWarning("reconcile", `ensureWorkflowDbForBase could not reopen DB: ${(err as Error).message}`);
    return false;
  }
}

export function checkpointWorkflowDatabase(): void {
  checkpointDatabase();
}

export function vacuumWorkflowDatabase(): void {
  vacuumDatabase();
}

interface VerifiedRecoverEvidence {
  previewInput: LegacyImportPreviewCreateInput;
  preview: LegacyImportPreviewArtifact;
  backup: LegacyImportVerifiedBackup;
}

export interface VerifiedRecoverApplicationResult {
  receipt: LegacyImportApplicationReceipt;
  preview: LegacyImportPreviewArtifact;
  backup: LegacyImportVerifiedBackup;
  counts: {
    milestones: number;
    slices: number;
    tasks: number;
  };
}

function countRecoverRows(database: DbAdapter, table: "milestones" | "slices" | "tasks"): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"] ?? 0);
}

function prepareVerifiedRecoverEvidence(basePath: string): VerifiedRecoverEvidence {
  const location = resolveWorkflowDatabaseLocation(basePath);
  const databasePath = getWorkflowDatabasePath();
  if (
    !databasePath
    || databasePath === ":memory:"
    || realpathSync(databasePath) !== realpathSync(location.projectDb)
  ) {
    throw new Error("gsd recover requires the open, file-backed project database");
  }

  const previewInput: LegacyImportPreviewCreateInput = {
    roots: [
      {
        id: "project-phases",
        kind: "project" as const,
        physical_path: join(location.projectGsd, "phases"),
        logical_path: ".gsd/phases",
        presence: "optional" as const,
      },
      {
        id: "project-milestones",
        kind: "project" as const,
        physical_path: join(location.projectGsd, "milestones"),
        logical_path: ".gsd/milestones",
        presence: "optional" as const,
      },
    ],
  };
  const preview = createLegacyImportPreview(previewInput);
  const base = captureCurrentLegacyImportBaseSnapshot();
  const destinationDirectory = join(location.projectGsd, "backups");
  mkdirSync(destinationDirectory, { recursive: true });
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots: previewInput.roots,
    destination_directory: destinationDirectory,
    label: "pre-recover",
  });
  drillLegacyImportBackupRestore({ backup, preview, base });
  return { previewInput, preview, backup };
}

export function prepareVerifiedRecoverBackup(basePath: string): LegacyImportVerifiedBackup {
  return prepareVerifiedRecoverEvidence(basePath).backup;
}

export function applyVerifiedRecoverApplication(basePath: string): VerifiedRecoverApplicationResult {
  const evidence = prepareVerifiedRecoverEvidence(basePath);
  const receipt = applyLegacyImport({
    invocation: {
      idempotencyKey: `legacy-import/recover/${evidence.preview.preview.preview_id}`,
      sourceTransport: "internal",
      actorType: "system",
      actorId: "gsd-recover",
    },
    previewInput: evidence.previewInput,
    preview: evidence.preview,
    backup: evidence.backup,
  });
  const database = _getAdapter();
  if (!database) throw new Error("gsd recover lost its open project database");
  return {
    receipt,
    preview: evidence.preview,
    backup: evidence.backup,
    counts: {
      milestones: countRecoverRows(database, "milestones"),
      slices: countRecoverRows(database, "slices"),
      tasks: countRecoverRows(database, "tasks"),
    },
  };
}
