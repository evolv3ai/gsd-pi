import type { ModelIdIssue } from "./model-id.js";
import type { BucketRow, OrchestratorFacts, ProbeOutcome, ProductService, ProjectionResult, RowStatus, StageMap } from "./types.js";

export interface MapInputs {
  projection: ProjectionResult;
  probes: ProbeOutcome[];
  modelIdIssues: ModelIdIssue[];
  orchestrator: OrchestratorFacts | null;
  gsdBinary: string;
  gsdVersion: string | null;
  generatorVersion: string;
  projectRoot: string;
  gitBranch: string | null;
  product: ProductService[];
  exercisedBuckets?: string[];
}

function providerOf(modelId: string): string {
  return modelId.split("/")[0] ?? modelId;
}

/** Honesty ladder (spec §4): "configured but never dispatched" must never render as verified. */
function bucketStatus(bucket: string, modelId: string, probes: ProbeOutcome[], exercised: Set<string>): RowStatus {
  if (exercised.has(bucket)) return "exercised";
  const provider = providerOf(modelId);
  const authOk = probes.some((p) => p.tier === "auth" && p.target === provider && p.verdict === "ok");
  const pingOk = probes.some((p) => p.tier === "ping" && p.target === `ping:${bucket}` && p.verdict === "ok");
  return authOk || pingOk ? "probed-ok" : "configured";
}

export function assembleStageMap(inputs: MapInputs): StageMap {
  const exercised = new Set(inputs.exercisedBuckets ?? []);
  const buckets: BucketRow[] = Object.entries(inputs.projection.buckets)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, model]) => ({
      bucket,
      model,
      source: inputs.projection.sources[bucket] ?? "global",
      status: bucketStatus(bucket, model, inputs.probes, exercised),
    }));
  return {
    orchestrator: inputs.orchestrator,
    planning: {
      skillAvailable: inputs.orchestrator ? inputs.orchestrator.skills.includes("planf3") : null,
      inheritsModel: inputs.orchestrator?.model ?? null,
    },
    exportStage: { generatorVersion: inputs.generatorVersion },
    gsdBuild: { binary: inputs.gsdBinary, version: inputs.gsdVersion, buckets },
    project: { root: inputs.projectRoot, branch: inputs.gitBranch },
    product: inputs.product,
    probes: inputs.probes,
    projection: inputs.projection,
    validationIssues: inputs.modelIdIssues.map((i) => `${i.where}: ${i.reason} (${i.id})`),
  };
}
