import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import { projectionHash } from "./hash.js";
import { projectPreferences } from "./projection.js";
import { readPresets } from "./presets-file.js";
import type { DriftRow, OrchestratorFacts, PresetsRecord, ProbeOutcome, ProjectionResult, Verdict } from "./types.js";

export interface VerdictResult {
  verdict: Verdict;
  drift: DriftRow[];
  reason: string;
}

function configDrift(current: ProjectionResult, record: PresetsRecord): DriftRow[] {
  // Field-level diff against the RECORDED bucket rows (the approval's rendered
  // surface); commands diff as a single row when the sets differ.
  const rows: DriftRow[] = [];
  const approvedBuckets = new Map(record.stages.gsdBuild.buckets.map((b) => [b.bucket, b.model]));
  const names = new Set([...approvedBuckets.keys(), ...Object.keys(current.buckets)]);
  for (const bucket of [...names].sort()) {
    const approved = approvedBuckets.get(bucket) ?? "(absent)";
    const now = current.buckets[bucket] ?? "(absent)";
    if (approved !== now) rows.push({ kind: "config", field: `buckets.${bucket}`, approved, current: now });
  }
  if (rows.length === 0) {
    // Hash mismatch but bucket rows agree → verification_commands changed.
    rows.push({ kind: "config", field: "verification_commands", approved: "(as approved)", current: current.verificationCommands.join(", ") });
  }
  return rows;
}

function probeDrift(record: PresetsRecord, currentProbes: ProbeOutcome[]): DriftRow[] {
  // The approval record is the baseline, not an ideal state: only ok→failing
  // regressions count (spec §10); already-failing sign-off probes never flip.
  const okAtSignOff = new Set(record.probes.filter((p) => p.verdict === "ok").map((p) => p.target));
  return currentProbes
    .filter((p) => okAtSignOff.has(p.target) && (p.verdict === "failed" || p.verdict === "unreachable"))
    .map((p) => ({ kind: "probe" as const, field: p.target, approved: "ok", current: p.verdict }));
}

export function computeVerdict(
  record: PresetsRecord | null,
  current: { projection: ProjectionResult; planPath: string | null; probes: ProbeOutcome[] },
): VerdictResult {
  if (record === null || record.approval === null) {
    return { verdict: "unapproved", drift: [], reason: "no signed-off PRESETS record" };
  }
  if (record.approval.projectedFrom !== current.planPath) {
    // Bare-vs-plan in either direction is unapproved, never drift (spec §4).
    return { verdict: "unapproved", drift: [], reason: `this projection (${current.planPath ?? "bare"}) was never signed — the approval covers ${record.approval.projectedFrom ?? "a bare projection"}` };
  }
  const currentHash = projectionHash(current.projection);
  if (currentHash !== record.approval.approvalHash) {
    const drift = configDrift(current.projection, record);
    return { verdict: "drift", drift, reason: "bridge-owned config changed out-of-band since sign-off" };
  }
  const probes = probeDrift(record, current.probes);
  if (probes.length > 0) {
    return { verdict: "drift", drift: probes, reason: "a credential that probed ok at sign-off is now failing" };
  }
  return { verdict: "ok", drift: [], reason: "matches the signed-off record" };
}

export interface SignOffInput {
  base: PresetsRecord;
  previous: PresetsRecord | null;
  facts: OrchestratorFacts | null;
  note: string | null;
  projectedFrom: string | null;
  /** projectionHash(projection) — computed by the caller, which holds the projection. */
  approvalHash: string;
  now: () => string;
}

export function signOff(input: SignOffInput): PresetsRecord {
  const at = input.now();
  const history = [...(input.previous?.history ?? [])];
  if (input.previous?.approval) history.push({ ...input.previous.approval, supersededAt: at });
  return {
    ...input.base,
    approval: {
      approvedAt: at,
      approvedBy: input.facts ? { model: input.facts.model, authMode: input.facts.authMode } : null,
      note: input.note,
      approvalHash: input.approvalHash,
      projectedFrom: input.projectedFrom,
    },
    history,
  };
}

export interface PresetsGateResult {
  presets: "ok" | "forced" | "absent" | "drift";
  presetsHash: string | null;
  refusal: string | null;
  drift: DriftRow[];
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Enforced-lite build gate (spec §7). Recomputes the projection from disk alone
 * — PRESETS.md, global + project PREFERENCES.md, and the plan's #model-policy /
 * #validation — per the §5.1 disk-recomputable rule. Never probes (no network
 * before export); probe-drift belongs to --check.
 */
export async function checkPresetsGate(
  projectRoot: string,
  htmlPath: string,
  opts: { force: boolean; globalPrefsPath?: string },
): Promise<PresetsGateResult> {
  const rerun = `run /planf3-gsd-preflight ${htmlPath} and sign off, or pass --force to build anyway`;
  // The whole disk-recomputation (PRESETS.md, the plan html, and the projection
  // merge over .gsd/PREFERENCES.md) is one failure domain: any of those reads
  // or parses can throw on real-world on-disk mess (corrupt frontmatter, a
  // moved plan file, …), and none of that is the gate's business to crash
  // on — it should refuse (or, under --force, proceed) exactly like an
  // unreadable PRESETS.md does today.
  try {
    const record = await readPresets(projectRoot);
    const html = await readFile(htmlPath, "utf8");
    const plan = parsePlanf3Html(html);
    const projection = projectPreferences({
      globalContent: await readOrNull(opts.globalPrefsPath ?? join(homedir(), ".gsd", "PREFERENCES.md")),
      projectContent: await readOrNull(join(projectRoot, ".gsd", "PREFERENCES.md")),
      modelPolicy: plan.modelPolicy as Record<string, string>,
      validationCommands: plan.validationCommands,
      sourceHtmlPath: htmlPath,
    });
    const result = computeVerdict(record, { projection, planPath: htmlPath, probes: [] });
    const hash = projectionHash(projection);

    if (result.verdict === "ok") return { presets: "ok", presetsHash: hash, drift: [], refusal: null };
    if (opts.force) return { presets: "forced", presetsHash: hash, drift: result.drift, refusal: null };
    if (result.verdict === "unapproved") {
      return { presets: "absent", presetsHash: hash, drift: [], refusal: `preflight gate: ${result.reason} — ${rerun}` };
    }
    const diffLines = result.drift.map((d) => `  ${d.field}: ${d.approved} → ${d.current}`).join("\n");
    return { presets: "drift", presetsHash: hash, drift: result.drift, refusal: `preflight gate: configuration drifted since sign-off:\n${diffLines}\n${rerun}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { presets: opts.force ? "forced" : "absent", presetsHash: null, drift: [], refusal: opts.force ? null : `preflight gate could not be computed (${msg}) — ${rerun}` };
  }
}
