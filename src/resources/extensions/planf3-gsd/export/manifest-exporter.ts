import type { ParsedPlan, PlanPhase, PlanTier, GsdModelPhaseKey } from "../parser/types.js";
import { GENERATOR_VERSION } from "../version.js";
import { pf3PhaseId, pf3TaskId } from "./pf3-id.js";

export interface TaskMapping { title: string; tier: PlanTier | null; pf3Id: string; /** GSD task id — populated by sync when observed (M4); null until then. */ gsdTask: string | null; }
export interface PhaseMapping {
  planf3Selector: string;
  title: string;
  pf3Id: string;
  tier: PlanTier | null;
  checks: string[];
  gsdMilestone: string | null;
  /** GSD slice id — populated by sync when observed (M4); null until then. */
  gsdSlice: string | null;
  tasks: TaskMapping[];
}

export interface BridgeManifest {
  schemaVersion: 1;
  planf3: { htmlPath: string; title: string; created: string | null; modified: string[]; };
  gsd: {
    specPath: string;
    projectRoot: string;
    milestoneId: string | null;
    headlessSessionId: string | null;
    mode: "auto" | "step";
  };
  mapping: { phases: PhaseMapping[]; };
  routing: { modelPolicy: Partial<Record<GsdModelPhaseKey, string>> };
  product: { service: string; envVars: string[] }[];
  /** Sign-off stamp. approvalHash is null when no approval existed at stamp
   *  time (unapproved record, or --force past a missing/corrupt PRESETS). */
  presets: { path: string; approvalHash: string | null } | null;
  validation: { commands: string[]; lastSyncedAt: string | null; lastStatus: "planned" | "running" | "passed" | "failed" | "blocked"; };
  provenance: { userPrompt: string | null; generator: "planf3-gsd-pi"; generatorVersion: string; };
}

export interface ManifestPaths {
  htmlPath: string;
  specPath: string;
  projectRoot: string;
}

export interface ManifestProvenance {
  userPrompt: string | null;
  mode: "auto" | "step";
}

function phaseChecks(phase: PlanPhase): string[] {
  const strategy = phase.tasks.find((t) => /testing strategy/i.test(t.title));
  if (!strategy) return [];
  return strategy.checklist
    .map((item) => item.command)
    .filter((c): c is string => c !== null && c.length > 0);
}

export function buildManifest(plan: ParsedPlan, paths: ManifestPaths, prov: ManifestProvenance, presets: { path: string; approvalHash: string | null } | null = null): BridgeManifest {
  return {
    schemaVersion: 1,
    planf3: {
      htmlPath: paths.htmlPath,
      title: plan.title,
      created: plan.metadata.created,
      modified: plan.metadata.modified,
    },
    gsd: {
      specPath: paths.specPath,
      projectRoot: paths.projectRoot,
      milestoneId: null,
      headlessSessionId: null,
      mode: prov.mode,
    },
    mapping: {
      phases: plan.phases.map((phase, i) => ({
        planf3Selector: `section#phases > div.phase:nth-of-type(${i + 1})`,
        title: phase.title,
        pf3Id: pf3PhaseId(i),
        tier: phase.tier,
        checks: phaseChecks(phase),
        gsdMilestone: null,
        gsdSlice: null,
        tasks: phase.tasks.map((t, j) => ({ title: t.title, tier: t.tier, pf3Id: pf3TaskId(i, j), gsdTask: null })),
      })),
    },
    routing: { modelPolicy: plan.modelPolicy },
    product: plan.integrations.map((i) => ({ service: i.service, envVars: i.envVars })),
    presets,
    validation: {
      commands: plan.validationCommands,
      lastSyncedAt: null,
      lastStatus: "planned",
    },
    provenance: {
      userPrompt: prov.userPrompt,
      generator: "planf3-gsd-pi",
      generatorVersion: GENERATOR_VERSION,
    },
  };
}
