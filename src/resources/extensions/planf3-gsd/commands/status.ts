import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GsdRunner, type Spawner } from "../gsd/headless-runner.js";
import { realSpawner } from "../gsd/real-spawner.js";
import { mapQuerySnapshot, type BridgeStatus } from "../gsd/status-mapper.js";
import { buildEvalRow, appendEvalRow, hasStatusRowFor } from "../gsd/eval-log.js";
import { friendlyError } from "./error-message.js";

export interface StatusOptions {
  binary?: string;
  cwd?: string;
  spawn?: Spawner;
  now?: () => string;
}

interface ManifestRef {
  htmlPath: string;
  specPath: string;
  mode: "auto" | "step";
}

/** Find the bridge manifest (specs/*.manifest.json) that owns this milestone, if any. */
async function findBridgeManifest(cwd: string, milestoneId: string): Promise<ManifestRef | null> {
  let names: string[];
  try {
    names = await readdir(join(cwd, "specs"));
  } catch {
    return null; // no specs/ dir — nothing bridge-built here
  }
  for (const name of names.filter((n) => n.endsWith(".manifest.json")).sort()) {
    try {
      const manifest = JSON.parse(await readFile(join(cwd, "specs", name), "utf8"));
      if (manifest?.gsd?.milestoneId === milestoneId) {
        return {
          htmlPath: String(manifest.planf3?.htmlPath ?? ""),
          specPath: String(manifest.gsd?.specPath ?? ""),
          mode: manifest.gsd?.mode === "step" ? "step" : "auto",
        };
      }
    } catch {
      // unreadable manifest — skip it
    }
  }
  return null;
}

/**
 * One-time completion record for detached builds: the successful Editorial HN
 * run logged zero eval rows because completion happened in auto relaunches the
 * bridge never observed. Status is the bridge's next observation point.
 * Only milestones with a matching bridge manifest are logged (never foreign ones).
 */
async function backfillCompletionRow(cwd: string, status: BridgeStatus, now: () => string): Promise<void> {
  try {
    const completed = status.lastCompletedMilestone;
    if (completed === null) return;
    const manifest = await findBridgeManifest(cwd, completed.id);
    if (manifest === null) return;
    if (await hasStatusRowFor(cwd, completed.id)) return;
    await appendEvalRow(
      cwd,
      buildEvalRow({
        loggedAt: now(),
        htmlPath: manifest.htmlPath,
        specPath: manifest.specPath,
        milestoneId: completed.id,
        mode: manifest.mode,
        status,
        appliedModels: [],
        event: "status",
      }),
    );
  } catch {
    // Best-effort observation — never fail a status call over eval logging.
  }
}

export async function runStatus(opts: StatusOptions = {}): Promise<BridgeStatus> {
  const cwd = opts.cwd ?? process.cwd();
  const runner = new GsdRunner({
    binary: opts.binary,
    cwd,
    spawn: opts.spawn ?? realSpawner,
  });
  let status: BridgeStatus;
  try {
    const result = await runner.query();
    status = mapQuerySnapshot(result.json);
  } catch (err) {
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }
  await backfillCompletionRow(cwd, status, opts.now ?? (() => new Date().toISOString()));
  return status;
}
