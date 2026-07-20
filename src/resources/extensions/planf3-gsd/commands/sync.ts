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
import { correlate, mappingViewOf, type CorrelationResult } from "../sync/correlate.js";
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
  /** Human-readable notes for bindings persisted this run (M4), e.g. "bound slice PF3-P1 ↔ S1". */
  bound: string[];
}

function describeChanges(applied: AppliedChange[], metaChanges: string[], unmatched: string[], bound: string[]): string {
  const lines = applied.map((c) => `  ${c.from} → ${c.to}  ${c.label}`);
  lines.push(...metaChanges.map((c) => `  ${c}`));
  lines.push(...bound.map((b) => `  ${b}`));
  if (unmatched.length > 0) lines.push(`  unmatched: ${unmatched.map((u) => `"${u}"`).join(", ")}`);
  return lines.join("\n");
}

/** Mutates manifest.mapping.phases in place; returns human-readable notes (empty = nothing to persist). */
function applyBindings(manifest: Record<string, unknown>, c: CorrelationResult): string[] {
  const notes: string[] = [];
  const mapping = manifest.mapping;
  const phases = mapping && typeof mapping === "object" && Array.isArray((mapping as { phases?: unknown }).phases)
    ? ((mapping as { phases: unknown[] }).phases)
    : null;
  if (phases === null) return notes;
  const phaseAt = (i: number): Record<string, unknown> | null => {
    const p = phases[i];
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  };
  if (c.newSliceBinding !== null) {
    const p = phaseAt(c.newSliceBinding.phaseIndex);
    if (p !== null) {
      p.gsdSlice = c.newSliceBinding.gsdSlice;
      notes.push(`bound slice ${typeof p.pf3Id === "string" ? p.pf3Id : `#${c.newSliceBinding.phaseIndex + 1}`} ↔ ${c.newSliceBinding.gsdSlice}`);
    }
  }
  if (c.newTaskBinding !== null) {
    const p = phaseAt(c.newTaskBinding.phaseIndex);
    const tasks = p !== null && Array.isArray(p.tasks) ? (p.tasks as unknown[]) : null;
    const t = tasks?.[c.newTaskBinding.taskIndex];
    if (t && typeof t === "object" && !Array.isArray(t)) {
      (t as Record<string, unknown>).gsdTask = c.newTaskBinding.gsdTask;
      notes.push(`bound task ${typeof (t as Record<string, unknown>).pf3Id === "string" ? (t as Record<string, unknown>).pf3Id as string : `#${c.newTaskBinding.taskIndex + 1}`} ↔ ${c.newTaskBinding.gsdTask}`);
    }
  }
  return notes;
}

/** F6.0-8: the completion sweep keeps the manifest's validation record
 *  truthful — custody-round completions never pass through runBuild, which
 *  is otherwise the only writer of validation.lastStatus (observed stuck on
 *  "running" for a fully-swept milestone). Mutates in place; null = already
 *  passed, nothing to persist. */
function applyValidationUpkeep(manifest: Record<string, unknown>, nowIso: string): string | null {
  const existing = manifest.validation;
  const validation = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : {};
  if (validation.lastStatus === "passed") return null;
  validation.lastStatus = "passed";
  validation.lastSyncedAt = nowIso;
  manifest.validation = validation;
  return "validation.lastStatus → passed";
}

/** Atomic same-directory write: temp + rename, best-effort temp cleanup on failure. */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmpPath = join(dirname(path), `.${basename(path)}.sync-tmp-${process.pid}`);
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, path);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

/** Active/last-completed milestone ids, queried lazily and at most once —
 *  used to pre-filter multi-candidate manifests (M4 locate rider). */
export function activeIdsOf(runner: GsdRunner): () => Promise<string[]> {
  let cached: string[] | null = null;
  return async () => {
    if (cached === null) {
      const s = mapQuerySnapshot((await runner.query()).json);
      cached = [s.activeMilestone?.id, s.lastCompletedMilestone?.id].filter((x): x is string => typeof x === "string");
    }
    return cached;
  };
}

export async function runSync(htmlPathArg: string | null, dryRun: boolean, opts: SyncOptions = {}): Promise<SyncOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const none: AppliedChange[] = [];

  const runner = new GsdRunner({ binary: opts.binary, cwd, spawn: opts.spawn ?? realSpawner });
  const located = await locateSyncTarget(cwd, htmlPathArg, { activeIds: activeIdsOf(runner) });
  if (!located.ok) return { kind: "not-located", message: located.message, applied: none, unmatched: [], bound: [] };
  const { htmlPath, manifestPath, milestoneId } = located.target;

  let html: string;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  const plan = parsePlanf3Html(html);

  // The manifest is a machine artifact: read it whole for the mapping view and
  // (later) binding persistence. Corrupt/legacy content degrades to no mapping.
  let manifest: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    manifest = null;
  }

  let snapshot: unknown;
  try {
    snapshot = (await runner.query()).json;
  } catch (err) {
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }
  const status = mapQuerySnapshot(snapshot);

  const correlation = correlate(plan, mappingViewOf(manifest), status);
  const computed = computeSync(plan, status, milestoneId, correlation);
  if (!computed.observable) {
    return { kind: "not-observable", message: `milestone ${milestoneId} not observable in current gsd state; nothing synced`, applied: none, unmatched: [], bound: [] };
  }

  const now = opts.now ?? (() => new Date().toISOString());

  // Persist observed bindings (rungs 2/3/4) BEFORE the marker-write decision:
  // a binding can be new even when every marker is already correct. F6.0-8:
  // the completion sweep also upserts validation.lastStatus in the SAME
  // atomic write. Dry-run persists nothing. Atomic like the HTML write
  // (temp + rename); one write whether bindings, validation, or both changed.
  const bound: string[] = [];
  if (!dryRun && manifest !== null) {
    const notes = applyBindings(manifest, correlation);
    if (computed.completed) {
      const upkeep = applyValidationUpkeep(manifest, now());
      if (upkeep !== null) notes.push(upkeep);
    }
    if (notes.length > 0) {
      await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      bound.push(...notes);
    }
  }

  const rewritten = rewriteHtml(html, computed.updates, computed.expectedMarkerCount, {
    gsdMilestone: milestoneId,
    gsdSession: status.sessionId,
    syncStamp: now(),
  });
  if (!rewritten.ok) {
    return { kind: "aborted", message: `${rewritten.reason} — nothing written`, applied: none, unmatched: computed.unmatched, bound };
  }

  const detail = describeChanges(rewritten.applied, rewritten.metaChanges, computed.unmatched, bound);

  if (!rewritten.changed) {
    const suffix = computed.unmatched.length > 0 ? `; unmatched: ${computed.unmatched.map((u) => `"${u}"`).join(", ")}` : "";
    const boundSuffix = bound.length > 0 ? `\n${bound.map((b) => `  ${b}`).join("\n")}` : "";
    return { kind: "no-change", message: `already in sync — 0 changes${suffix}${boundSuffix}`, applied: none, unmatched: computed.unmatched, bound };
  }

  if (dryRun) {
    return {
      kind: "dry-run",
      message: `dry-run: would sync ${rewritten.applied.length} marker(s) in ${htmlPath}\n${detail}`,
      applied: rewritten.applied,
      unmatched: computed.unmatched,
      bound,
    };
  }

  // Atomic on the same filesystem: temp file in the same directory + rename.
  // No backup file — plans live in git. PID suffix avoids collisions between
  // concurrent syncs; on failure the temp file is best-effort cleaned up.
  await atomicWrite(htmlPath, rewritten.html);

  return {
    kind: "synced",
    message: `synced ${rewritten.applied.length} marker(s) in ${htmlPath}\n${detail}`,
    applied: rewritten.applied,
    unmatched: computed.unmatched,
    bound,
  };
}
