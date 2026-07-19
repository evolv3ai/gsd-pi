/**
 * /planf3-gsd-steer|pause|resume|stop (M4, PRD FR-9/FR-10): thin passthroughs
 * to `gsd headless <cmd>` via GsdRunner. Steer/stop are eval-logged (they
 * redirect or abandon paid work); pause/resume are flow control — no row.
 * Resume runs ONE bounded invocation (auto or next per the manifest's mode);
 * long runs belong under orchestrator custody (F-6.1/F-6.2 lesson).
 */
import { readFile } from "node:fs/promises";
import { GsdRunner, type Spawner, type GsdResult } from "../gsd/headless-runner.js";
import { realSpawner } from "../gsd/real-spawner.js";
import { mapQuerySnapshot } from "../gsd/status-mapper.js";
import { buildControlEvalRow, appendEvalRow } from "../gsd/eval-log.js";
import { locateSyncTarget } from "../sync/locate.js";
import { activeIdsOf } from "./sync.js";

export interface ControlOptions { binary?: string; cwd?: string; spawn?: Spawner; now?: () => string }

export type ControlOutcome =
  | { kind: "ok"; message: string; exitCode: number }
  | { kind: "usage"; message: string }
  | { kind: "not-located"; message: string };

export const STEER_USAGE = 'Usage: /planf3-gsd-steer "<one quoted instruction>"';

export const CUSTODY_REMINDER =
  "reminder: long runs belong under orchestrator custody — this was ONE bounded gsd round; run /planf3-gsd-sync after each round to keep markers moving.";

function makeRunner(cwd: string, opts: ControlOptions): GsdRunner {
  return new GsdRunner({ binary: opts.binary, cwd, spawn: opts.spawn ?? realSpawner });
}

/** Best-effort manifest context for eval rows: null fields when nothing located. */
async function locatedRowFields(cwd: string): Promise<{ htmlPath: string | null; specPath: string | null; milestoneId: string | null }> {
  try {
    const located = await locateSyncTarget(cwd, null);
    if (!located.ok) return { htmlPath: null, specPath: null, milestoneId: null };
    let specPath: string | null = null;
    try {
      const manifest = JSON.parse(await readFile(located.target.manifestPath, "utf8")) as { gsd?: { specPath?: unknown } };
      specPath = typeof manifest.gsd?.specPath === "string" ? manifest.gsd.specPath : null;
    } catch {
      specPath = null;
    }
    return { htmlPath: located.target.htmlPath, specPath, milestoneId: located.target.milestoneId };
  } catch {
    return { htmlPath: null, specPath: null, milestoneId: null };
  }
}

async function logControlRow(cwd: string, event: "steer" | "stop", steerText: string | null, result: GsdResult, now: () => string): Promise<void> {
  try {
    const fields = await locatedRowFields(cwd);
    await appendEvalRow(cwd, buildControlEvalRow({
      loggedAt: now(),
      event,
      ...fields,
      ...(steerText !== null ? { steerText } : {}),
      exitCode: result.exitCode,
      cost: mapQuerySnapshot(result.json).cost,
    }));
  } catch {
    // Eval logging is best-effort; never fail a control command over it.
  }
}

export async function runSteer(instruction: string, opts: ControlOptions = {}): Promise<ControlOutcome> {
  const text = instruction.trim();
  if (text.length === 0) return { kind: "usage", message: STEER_USAGE };
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const result = await makeRunner(cwd, opts).steer(text);
  await logControlRow(cwd, "steer", text, result, now);
  return { kind: "ok", message: `steer sent (exit ${result.exitCode}): "${text}"`, exitCode: result.exitCode };
}

export async function runPause(opts: ControlOptions = {}): Promise<ControlOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const result = await makeRunner(cwd, opts).pause();
  return { kind: "ok", message: `paused (exit ${result.exitCode})`, exitCode: result.exitCode };
}

export async function runStop(opts: ControlOptions = {}): Promise<ControlOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const result = await makeRunner(cwd, opts).stop();
  await logControlRow(cwd, "stop", null, result, now);
  return { kind: "ok", message: `stop sent (exit ${result.exitCode})`, exitCode: result.exitCode };
}

export async function runResume(htmlPathArg: string | null, opts: ControlOptions = {}): Promise<ControlOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const runner = makeRunner(cwd, opts);
  const located = await locateSyncTarget(cwd, htmlPathArg, { activeIds: activeIdsOf(runner) });
  if (!located.ok) return { kind: "not-located", message: located.message };
  let mode: "auto" | "step" = "auto";
  try {
    const manifest = JSON.parse(await readFile(located.target.manifestPath, "utf8")) as { gsd?: { mode?: unknown } };
    mode = manifest.gsd?.mode === "step" ? "step" : "auto";
  } catch {
    mode = "auto"; // corrupt manifest — FR-10 default
  }
  const result = mode === "auto" ? await runner.auto() : await runner.next();
  return {
    kind: "ok",
    message: `resumed via gsd headless ${mode === "auto" ? "auto" : "next"} (exit ${result.exitCode})\n${CUSTODY_REMINDER}`,
    exitCode: result.exitCode,
  };
}
