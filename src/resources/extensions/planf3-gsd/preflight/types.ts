/** Shared types for the preflight/PRESETS feature (spec 2026-07-05, §4-§8). */

export type { PlanIntegration } from "../parser/types.js";

export type ProbeTier = "static" | "auth" | "ping";
export type ProbeVerdict = "ok" | "failed" | "unreachable" | "skipped" | "unavailable";

export interface ProbeOutcome {
  /** What was probed, e.g. "openrouter" or "gsd-binary". */
  target: string;
  tier: ProbeTier;
  verdict: ProbeVerdict;
  /** Fixed text + status codes only — NEVER credential material. */
  detail: string;
  checkedAt: string;
  /** Extra cost note for ping rows, e.g. "≈$0.001" or "spawns process". */
  cost?: string;
}

/** Honesty ladder (spec §4): exercised only with handed-in evidence. */
export type RowStatus = "configured" | "probed-ok" | "exercised";

export interface BucketRow {
  bucket: string;
  model: string;
  source: "global" | "project" | "plan";
  status: RowStatus;
}

export type EnvProvenance = "env-file" | "process-env" | "not-found";
export interface EnvVarFinding {
  name: string;
  provenance: EnvProvenance;
  /** Which env file (".env.local" etc.) when provenance is "env-file". */
  file: string | null;
}

export interface ProductService {
  service: string;
  envVars: EnvVarFinding[];
  /** True when derived from the heuristic, not #integrations markup. */
  guessed: boolean;
  /** "may be tool-injected — not detectable" disclaimer applies. */
  injectionDisclaimer: boolean;
}

export interface OrchestratorFacts {
  host: string;
  model: string;
  authMode: string;
  skills: string[];
}

export interface ProjectionResult {
  /** Post-overlay bucket → model id (the hashed surface, spec §5.1). */
  buckets: Record<string, string>;
  /** Post-merge verification commands (the other hashed key). */
  verificationCommands: string[];
  /** Which layer supplied each bucket's value. */
  sources: Record<string, "global" | "project" | "plan">;
  /** EVERY model id found (buckets + hand-written tier_models) for tier-0
   *  validation — validation ≠ ownership (spec §5.1). */
  allModelIds: { id: string; where: string }[];
}

export interface Approval {
  approvedAt: string;
  approvedBy: { model: string; authMode: string } | null;
  note: string | null;
  approvalHash: string;
  /** Plan path the projection was computed from; null = bare sign-off. */
  projectedFrom: string | null;
}

export interface PresetsRecord {
  schemaVersion: 1;
  approval: Approval | null;
  history: (Approval & { supersededAt: string })[];
  stages: {
    orchestrator: OrchestratorFacts | null;
    gsdBuild: { binary: string; version: string | null; buckets: BucketRow[] };
    exportStage: { generatorVersion: string };
    project: { root: string; branch: string | null };
  };
  product: ProductService[];
  probes: ProbeOutcome[];
}

export interface StageMap {
  orchestrator: OrchestratorFacts | null;
  planning: { skillAvailable: boolean | null; inheritsModel: string | null };
  exportStage: { generatorVersion: string };
  gsdBuild: { binary: string; version: string | null; buckets: BucketRow[] };
  project: { root: string; branch: string | null };
  product: ProductService[];
  probes: ProbeOutcome[];
  projection: ProjectionResult;
  validationIssues: string[]; // rendered tier-0 issues, e.g. "dynamic_routing.tier_models.light: model id not found…"
}

export type Verdict = "ok" | "drift" | "unapproved" | "error";

export interface DriftRow {
  kind: "config" | "probe";
  field: string;
  approved: string;
  current: string;
}
