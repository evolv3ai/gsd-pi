/**
 * /planf3-gsd-sync orchestration: locate → parse → query → compute → rewrite.
 * Consumes ONLY the documented headless surface (gsd headless query) — never
 * .gsd/ internals. Compute-everything-then-write-once: no partial writes.
 */
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import { GsdRunner, type Spawner } from "../gsd/headless-runner.js";
import { realSpawner } from "../gsd/real-spawner.js";
import { mapQuerySnapshot } from "../gsd/status-mapper.js";
import { computeSync } from "../sync/marker-map.js";
import { rewriteHtml, type AppliedChange } from "../sync/html-rewrite.js";
import { locateSyncTarget } from "../sync/locate.js";
import { friendlyError } from "./error-message.js";

export interface SyncOptions {
  binary?: string;
  cwd?: string;
  spawn?: Spawner;
  now?: () => string;
}

export type SyncOutcomeKind = "synced" | "no-change" | "dry-run" | "not-observable" | "aborted" | "not-located";

export interface SyncOutcome {
  kind: SyncOutcomeKind;
  message: string;
  applied: AppliedChange[];
  unmatched: string[];
}

function describeChanges(applied: AppliedChange[], metaChanges: string[], unmatched: string[]): string {
  const lines = applied.map((c) => `  ${c.from} → ${c.to}  ${c.label}`);
  lines.push(...metaChanges.map((c) => `  ${c}`));
  if (unmatched.length > 0) lines.push(`  unmatched: ${unmatched.map((u) => `"${u}"`).join(", ")}`);
  return lines.join("\n");
}

export async function runSync(htmlPathArg: string | null, dryRun: boolean, opts: SyncOptions = {}): Promise<SyncOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const none: AppliedChange[] = [];

  const located = await locateSyncTarget(cwd, htmlPathArg);
  if (!located.ok) return { kind: "not-located", message: located.message, applied: none, unmatched: [] };
  const { htmlPath, milestoneId } = located.target;

  let html: string;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  const plan = parsePlanf3Html(html);

  const runner = new GsdRunner({ binary: opts.binary, cwd, spawn: opts.spawn ?? realSpawner });
  let snapshot: unknown;
  try {
    snapshot = (await runner.query()).json;
  } catch (err) {
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }
  const status = mapQuerySnapshot(snapshot);

  const computed = computeSync(plan, status, milestoneId);
  if (!computed.observable) {
    return {
      kind: "not-observable",
      message: `milestone ${milestoneId} not observable in current gsd state; nothing synced`,
      applied: none,
      unmatched: [],
    };
  }

  const now = opts.now ?? (() => new Date().toISOString());
  const rewritten = rewriteHtml(html, computed.updates, computed.expectedMarkerCount, {
    gsdMilestone: milestoneId,
    gsdSession: status.sessionId,
    syncStamp: now(),
  });
  if (!rewritten.ok) {
    return { kind: "aborted", message: `${rewritten.reason} — nothing written`, applied: none, unmatched: computed.unmatched };
  }

  const detail = describeChanges(rewritten.applied, rewritten.metaChanges, computed.unmatched);

  if (!rewritten.changed) {
    const suffix = computed.unmatched.length > 0 ? `; unmatched: ${computed.unmatched.map((u) => `"${u}"`).join(", ")}` : "";
    return { kind: "no-change", message: `already in sync — 0 changes${suffix}`, applied: none, unmatched: computed.unmatched };
  }

  if (dryRun) {
    return {
      kind: "dry-run",
      message: `dry-run: would sync ${rewritten.applied.length} marker(s) in ${htmlPath}\n${detail}`,
      applied: rewritten.applied,
      unmatched: computed.unmatched,
    };
  }

  // Atomic on the same filesystem: temp file in the same directory + rename.
  // No backup file — plans live in git. PID suffix avoids collisions between
  // concurrent syncs; on failure the temp file is best-effort cleaned up.
  const tmpPath = join(dirname(htmlPath), `.${basename(htmlPath)}.sync-tmp-${process.pid}`);
  try {
    await writeFile(tmpPath, rewritten.html, "utf8");
    await rename(tmpPath, htmlPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // best-effort cleanup — ignore
    }
    throw err;
  }

  return {
    kind: "synced",
    message: `synced ${rewritten.applied.length} marker(s) in ${htmlPath}\n${detail}`,
    applied: rewritten.applied,
    unmatched: computed.unmatched,
  };
}
