import { basename, dirname, join, resolve } from "node:path";

import { GSDError, GSD_STALE_STATE } from "./errors.js";

export interface DatabaseReplacementPaths {
  readonly recoveryDirectory: string;
  readonly activeIntentPath: string;
}

export function getDatabaseReplacementPaths(databasePath: string): DatabaseReplacementPaths {
  if (typeof databasePath !== "string" || databasePath.length === 0 || databasePath === ":memory:") {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database replacement requires a file-backed database path");
  }
  const resolvedPath = resolve(databasePath);
  const recoveryDirectory = join(dirname(resolvedPath), `${basename(resolvedPath)}.recovery`);
  return Object.freeze({
    recoveryDirectory,
    activeIntentPath: join(recoveryDirectory, "active.json"),
  });
}
