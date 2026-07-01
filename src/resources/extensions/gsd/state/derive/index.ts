// Project/App: gsd-pi
// File Purpose: deriveState orchestrator — cache, DB open, pure DB projection.

import type { GSDState } from '../../types.js';
import { loadFile } from '../../files.js';
import { resolveGsdRootFile } from '../../paths.js';
import { isDbAvailable } from '../../gsd-db.js';
import { wasWorkflowDatabaseOpenAttempted } from '../../db-workspace.js';
import { debugCount, debugTime } from '../../debug-logger.js';
import { logWarning } from '../../workflow-logger.js';

import {
  getDeriveTelemetry,
  incrementDbDeriveCount,
  invalidateStateCache,
  readCachedDeriveState,
  resetDeriveTelemetry,
  writeCachedDeriveState,
} from './cache.js';
import {
  buildDbUnavailableState,
  ensureExistingWorkflowDbOpen,
} from './db-open.js';
import { deriveStateFromDb } from './from-db.js';

export interface DeriveStateOptions {
  projectRootForReads?: string;
}

export {
  getDeriveTelemetry,
  invalidateStateCache,
  resetDeriveTelemetry,
};

async function loadRecentDecisions(basePath: string): Promise<string[]> {
  const decisionsPath = resolveGsdRootFile(basePath, "DECISIONS");
  const content = await loadFile(decisionsPath);
  if (!content) return [];

  const fromTable = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) => {
      const cells = line
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
      if (cells.length < 6) return null;
      const id = cells[0];
      if (!/^D\d+$/i.test(id)) return null;
      const whenContext = cells[1];
      const decision = cells[3];
      const choice = cells[4];
      if (!decision || !choice) return null;
      return `${id} (${whenContext}): ${decision} -> ${choice}`;
    })
    .filter((value): value is string => value != null);

  if (fromTable.length > 0) return fromTable.slice(-5);

  const fromBullets = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-+\s+/, ""))
    .filter((line) => /^D\d+\b/i.test(line));

  return fromBullets.slice(-5);
}

export async function deriveState(
  basePath: string,
  opts?: DeriveStateOptions,
): Promise<GSDState> {
  const cacheKey = opts?.projectRootForReads ?? basePath;

  const cached = readCachedDeriveState(cacheKey);
  if (cached) return cached;

  const stopTimer = debugTime("derive-state-impl");
  let result: GSDState;

  ensureExistingWorkflowDbOpen(basePath);

  if (isDbAvailable()) {
    const stopDbTimer = debugTime("derive-state-db");
    result = await deriveStateFromDb(basePath, opts?.projectRootForReads ?? basePath);
    stopDbTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
    incrementDbDeriveCount();
  } else {
    if (wasWorkflowDatabaseOpenAttempted()) {
      logWarning("state", "DB unavailable — refusing implicit markdown state derivation");
    }
    result = buildDbUnavailableState();
  }

  result.recentDecisions = await loadRecentDecisions(cacheKey);
  stopTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
  debugCount("deriveStateCalls");
  writeCachedDeriveState(cacheKey, result);
  return result;
}
