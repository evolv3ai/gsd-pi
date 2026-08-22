// Project/App: gsd-pi
// File Purpose: Bounded filesystem/Git/DB preflight for orphan milestone discard.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { invalidateAllCaches } from "./cache.js";
import {
  discardOrphanMilestoneRows,
  preflightOrphanMilestoneRows,
  type OrphanMilestoneDbSnapshot,
} from "./db/writers/orphan-milestone-discard.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { gsdRoot, milestoneDirExists } from "./paths.js";
import { isSessionStale, type SessionStatus } from "./session-status-io.js";
import { worktreesDirs } from "./worktree-placement.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";

export interface OrphanMilestoneSnapshot extends OrphanMilestoneDbSnapshot {
  diskProjection: boolean | null;
  worktrees: string[] | null;
  milestoneBranch: boolean | null;
  queueOrderReference: boolean | null;
  activeWorkers: Array<{ pid: number; state: string }> | null;
  inspectionErrors: string[];
  orphan: boolean;
}

export type OrphanMilestoneDiscardResult =
  | { ok: true; command: "discard-milestone"; orphanOnly: true; before: OrphanMilestoneSnapshot[]; after: OrphanMilestoneSnapshot[] }
  | { ok: false; command: "discard-milestone"; orphanOnly: true; before: OrphanMilestoneSnapshot[]; after: OrphanMilestoneSnapshot[]; errors: string[] };

interface ExternalState {
  worktrees: Array<{ path: string; branch: string }>;
  branches: string[];
  queueOrder: string[];
  workerStatuses: SessionStatus[];
  physicalWorktrees: Map<string, string[]>;
}

function gitOutput(basePath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: GIT_NO_PROMPT_ENV,
  }).trim();
}

function loadQueueOrderStrict(basePath: string): string[] {
  const path = join(gsdRoot(basePath), "QUEUE-ORDER.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || !("order" in parsed)
    || !Array.isArray(parsed.order) || !parsed.order.every((id) => typeof id === "string")) {
    throw new Error("QUEUE-ORDER.json is malformed");
  }
  return parsed.order;
}

function isSessionStatus(value: unknown): value is SessionStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionStatus>;
  const currentUnitValid = candidate.currentUnit === null || (
    !!candidate.currentUnit
    && typeof candidate.currentUnit.type === "string"
    && typeof candidate.currentUnit.id === "string"
    && typeof candidate.currentUnit.startedAt === "number"
  );
  return typeof candidate.milestoneId === "string"
    && typeof candidate.pid === "number"
    && ["running", "paused", "stopped", "error"].includes(String(candidate.state))
    && currentUnitValid
    && typeof candidate.completedUnits === "number"
    && typeof candidate.cost === "number"
    && typeof candidate.lastHeartbeat === "number"
    && typeof candidate.startedAt === "number"
    && typeof candidate.worktreePath === "string";
}

function loadWorkerStatusesStrict(basePath: string): SessionStatus[] {
  const dir = join(gsdRoot(basePath), "parallel");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => entry.endsWith(".status.json")).map((entry) => {
    const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as unknown;
    if (!isSessionStatus(parsed)) throw new Error(`${entry} is malformed`);
    const fileMilestoneId = entry.slice(0, -".status.json".length);
    if (parsed.milestoneId !== fileMilestoneId) throw new Error(`${entry} has a mismatched milestone ID`);
    return parsed;
  });
}

function inspectExternalState(basePath: string, ids: readonly string[]): ExternalState {
  const worktreeOutput = gitOutput(basePath, ["worktree", "list", "--porcelain"]);
  const worktrees = worktreeOutput.split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) throw new Error("git worktree output is malformed");
    const branch = lines.find((line) => line.startsWith("branch refs/heads/"))
      ?.slice("branch refs/heads/".length) ?? "";
    return { path, branch };
  });
  const branches = gitOutput(basePath, ["branch", "--format=%(refname:short)", "--list"])
    .split("\n").filter(Boolean);
  const physicalWorktrees = new Map<string, string[]>();
  const containers = worktreesDirs(basePath);
  for (const id of ids) {
    const paths: string[] = [];
    for (const container of containers) {
      const candidate = join(container, id);
      try {
        lstatSync(candidate);
        paths.push(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    physicalWorktrees.set(id, paths);
  }
  return {
    worktrees,
    branches,
    queueOrder: loadQueueOrderStrict(basePath),
    workerStatuses: loadWorkerStatusesStrict(basePath),
    physicalWorktrees,
  };
}

function addExternalState(
  basePath: string,
  snapshots: readonly OrphanMilestoneDbSnapshot[],
  targetIds: ReadonlySet<string>,
  externalState: ExternalState | null,
  inspectionErrors: string[] = [],
): OrphanMilestoneSnapshot[] {
  return snapshots.map((snapshot) => {
    const branch = `milestone/${snapshot.id}`;
    const matchingWorktrees = externalState
      ? [...new Set([
        ...externalState.worktrees
          .filter((worktree) => worktree.branch === branch || basename(worktree.path) === snapshot.id)
          .map((worktree) => worktree.path),
        ...(externalState.physicalWorktrees.get(snapshot.id) ?? []),
      ])]
      : null;
    const diskProjection = inspectionErrors.length === 0 ? milestoneDirExists(basePath, snapshot.id) : null;
    const milestoneBranch = externalState?.branches.includes(branch) ?? null;
    const queueOrderReference = externalState?.queueOrder.includes(snapshot.id) ?? null;
    const activeWorkers = externalState?.workerStatuses
      .filter((status) => status.milestoneId === snapshot.id
        && (status.state === "running" || status.state === "paused")
        && !isSessionStale(status))
      .map((status) => ({ pid: status.pid, state: status.state })) ?? null;
    const orphan = snapshot.dbRow
      && snapshot.planningFields.length === 0
      && Object.keys(snapshot.relatedRows).length === 0
      && snapshot.dependentMilestones.every((dependent) => targetIds.has(dependent))
      && diskProjection === false
      && matchingWorktrees?.length === 0
      && milestoneBranch === false
      && queueOrderReference === false
      && activeWorkers?.length === 0
      && inspectionErrors.length === 0;
    return {
      ...snapshot,
      diskProjection,
      worktrees: matchingWorktrees,
      milestoneBranch,
      queueOrderReference,
      activeWorkers,
      inspectionErrors,
      orphan,
    };
  });
}

function mergeAfterSnapshots(
  before: readonly OrphanMilestoneSnapshot[],
  afterDb: readonly OrphanMilestoneDbSnapshot[],
): OrphanMilestoneSnapshot[] {
  const beforeById = new Map(before.map((snapshot) => [snapshot.id, snapshot]));
  return afterDb.map((snapshot) => ({
    ...beforeById.get(snapshot.id)!,
    ...snapshot,
    orphan: false,
  }));
}

export function discardOrphanMilestoneReservations(
  basePath: string,
  ids: readonly string[],
): OrphanMilestoneDiscardResult {
  const errors: string[] = [];
  if (ids.length === 0) errors.push("at least one milestone ID is required");
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length > 0) errors.push(`duplicate milestone IDs: ${duplicateIds.join(", ")}`);
  const invalidIds = ids.filter((id) => !MILESTONE_ID_RE.test(id));
  if (invalidIds.length > 0) errors.push(`invalid milestone IDs: ${invalidIds.join(", ")}`);
  if (errors.length > 0) {
    return { ok: false, command: "discard-milestone", orphanOnly: true, before: [], after: [], errors };
  }

  const projectRoot = resolveWorktreeProjectRoot(basePath);
  const targetIds = new Set(ids);
  const dbPreflight = preflightOrphanMilestoneRows(ids);
  let externalState: ExternalState | null = null;
  let inspectionErrors: string[] = [];
  try {
    externalState = inspectExternalState(projectRoot, ids);
  } catch (error) {
    inspectionErrors = [`external preflight failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const before = addExternalState(projectRoot, dbPreflight.before, targetIds, externalState, inspectionErrors);
  const externalErrors = before.flatMap((snapshot) => [
    ...(snapshot.diskProjection ? [`${snapshot.id}: disk projection exists`] : []),
    ...(snapshot.worktrees && snapshot.worktrees.length > 0 ? [`${snapshot.id}: worktree exists at ${snapshot.worktrees.join(", ")}`] : []),
    ...(snapshot.milestoneBranch ? [`${snapshot.id}: milestone branch exists`] : []),
    ...(snapshot.queueOrderReference ? [`${snapshot.id}: queue order reference exists`] : []),
    ...(snapshot.activeWorkers && snapshot.activeWorkers.length > 0 ? [`${snapshot.id}: active worker exists`] : []),
  ]);

  if (inspectionErrors.length > 0 || externalErrors.length > 0) {
    return {
      ok: false,
      command: "discard-milestone",
      orphanOnly: true,
      before,
      after: before,
      errors: [...dbPreflight.errors, ...inspectionErrors, ...externalErrors],
    };
  }
  if (dbPreflight.errors.length > 0) {
    return {
      ok: false,
      command: "discard-milestone",
      orphanOnly: true,
      before,
      after: before,
      errors: dbPreflight.errors,
    };
  }

  // Re-preflight under the reserved writer transaction immediately before the
  // set deletion, closing the gap after the filesystem/Git checks.
  const dbResult = discardOrphanMilestoneRows(ids);
  if (!dbResult.ok) {
    return {
      ...dbResult,
      command: "discard-milestone",
      orphanOnly: true,
      before: addExternalState(projectRoot, dbResult.before, targetIds, externalState),
      after: addExternalState(projectRoot, dbResult.after, targetIds, externalState),
    };
  }
  invalidateAllCaches();
  return {
    ok: true,
    command: "discard-milestone",
    orphanOnly: true,
    before,
    after: mergeAfterSnapshots(before, dbResult.after),
  };
}
