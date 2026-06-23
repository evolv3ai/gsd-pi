import type { ParsedPlan } from "../parser/types.ts";

export interface TaskMapping { title: string; gsdTask: string | null; }
export interface PhaseMapping {
  planf3Selector: string;
  title: string;
  gsdMilestone: string | null;
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
  validation: { commands: string[]; lastSyncedAt: string | null; lastStatus: "planned" | "running" | "passed" | "failed" | "blocked"; };
  provenance: { userPrompt: string | null; generator: "planf3-gsd-pi"; generatorVersion: "0.1.0"; };
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

export function buildManifest(plan: ParsedPlan, paths: ManifestPaths, prov: ManifestProvenance): BridgeManifest {
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
        planf3Selector: `section#phases div.phase:nth-of-type(${i + 1})`,
        title: phase.title,
        gsdMilestone: null,
        gsdSlice: null,
        tasks: phase.tasks.map((t) => ({ title: t.title, gsdTask: null })),
      })),
    },
    validation: {
      commands: plan.validationCommands,
      lastSyncedAt: null,
      lastStatus: "planned",
    },
    provenance: {
      userPrompt: prov.userPrompt,
      generator: "planf3-gsd-pi",
      generatorVersion: "0.1.0",
    },
  };
}
