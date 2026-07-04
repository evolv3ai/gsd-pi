// gsd-pi — Auto-worktree resource version module.
//
// Owns managed-resource freshness checks for long-running auto sessions.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gsdHome } from "./gsd-home.js";
import { logWarning } from "./workflow-logger.js";

/**
 * Read the resource version (semver) from the managed-resources manifest.
 * Uses gsdVersion instead of syncedAt so that launching a second session
 * doesn't falsely trigger staleness (#804).
 */
export function readResourceVersion(): string | null {
  const agentDir = process.env.GSD_CODING_AGENT_DIR || join(gsdHome(), "agent");
  const manifestPath = join(agentDir, "managed-resources.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return typeof manifest?.gsdVersion === "string"
      ? manifest.gsdVersion
      : null;
  } catch (e) {
    logWarning("worktree", `readResourceVersion failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Check if managed resources have been updated since session start.
 * Returns a warning message if stale, null otherwise.
 */
export function checkResourcesStale(
  versionOnStart: string | null,
): string | null {
  if (versionOnStart === null) return null;
  const current = readResourceVersion();
  if (current === null) return null;
  if (current !== versionOnStart) {
    return "GSD resources were updated since this session started. Restart gsd to load the new code.";
  }
  return null;
}
