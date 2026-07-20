import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { GsdRunner, type Spawner } from "../gsd/headless-runner.js";
import { realSpawner } from "../gsd/real-spawner.js";
import { mapQuerySnapshot, type BridgeStatus } from "../gsd/status-mapper.js";
import { buildEvalRow, appendEvalRow, hasStatusRowFor } from "../gsd/eval-log.js";
import { friendlyError } from "./error-message.js";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";

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
        appliedBuckets: [],
        appliedModels: {},
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

export interface StatusReport {
  status: BridgeStatus;
  /** Non-null when live progress implies work the plan's markers don't show (M4). */
  nudge: string | null;
}

export const STALE_NUDGE = "markers behind live state — run /planf3-gsd-sync";

/** Zero done markers in the plan the manifest points at. Empty htmlPath and
 *  parse failures count as "not zero" (no nudge); throws propagate to the
 *  caller's catch. */
async function planShowsZeroDone(cwd: string, manifest: ManifestRef): Promise<boolean> {
  if (manifest.htmlPath.length === 0) return false;
  const htmlPath = isAbsolute(manifest.htmlPath) ? manifest.htmlPath : join(cwd, manifest.htmlPath);
  const plan = parsePlanf3Html(await readFile(htmlPath, "utf8"));
  const doneMarkers =
    plan.phases.filter((p) => p.status === "done").length +
    plan.phases.reduce((acc, p) => acc + p.tasks.reduce((a, t) => a + t.checklist.filter((i) => i.status === "done").length, 0), 0);
  return doneMarkers === 0;
}

/**
 * Staleness nudge (M4 loop touchpoint c). Status stays read-only: this only
 * READS the plan HTML the bridge manifest points at. Two arms:
 *  - active milestone with completed slices/tasks but zero done markers;
 *  - F6.0-7: milestone completed but the sweep never ran (lastCompleted owns
 *    the manifest, plan still pristine) — the moment the nudge matters most.
 * Every failure degrades to null — a nudge must never break a status call.
 */
async function computeStaleNudge(cwd: string, status: BridgeStatus): Promise<string | null> {
  try {
    const active = status.activeMilestone;
    if (active !== null) {
      const progress = status.progress;
      if (progress === null) return null;
      if (progress.slices.done + progress.tasks.done === 0) return null;
      const manifest = await findBridgeManifest(cwd, active.id);
      if (manifest === null) return null;
      return (await planShowsZeroDone(cwd, manifest)) ? STALE_NUDGE : null;
    }
    const completed = status.lastCompletedMilestone;
    if (completed === null) return null;
    const manifest = await findBridgeManifest(cwd, completed.id);
    if (manifest === null) return null;
    return (await planShowsZeroDone(cwd, manifest)) ? STALE_NUDGE : null;
  } catch {
    return null;
  }
}

export async function runStatusReport(opts: StatusOptions = {}): Promise<StatusReport> {
  const cwd = opts.cwd ?? process.cwd();
  const status = await runStatus(opts);
  return { status, nudge: await computeStaleNudge(cwd, status) };
}
