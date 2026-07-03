// Project/App: gsd-pi
// File Purpose: ADR-015 Tool Contract module for Unit prompt, policy, and tool parity.

import {
  resolveManifest,
  type ArtifactKey,
  type ComputedArtifactId,
  type ContextModePolicy,
  type ToolsPolicy,
  type UnitContextManifest,
} from "./unit-context-manifest.js";
import {
  getWorkflowTransportSupportError,
  type WorkflowCapabilityOptions,
} from "./workflow-mcp.js";
import {
  getRequiredWorkflowToolsForUnit,
  getUnitToolSurfaceContract,
} from "./unit-tool-contracts.js";
import {
  WHOLE_FILE_OBSERVATION_MAX_BYTES,
  WHOLE_FILE_OBSERVATION_MAX_LINES,
} from "./source-observations.js";

export interface UnitToolContract {
  unitType: string;
  contextMode: ContextModePolicy;
  toolsPolicy: ToolsPolicy;
  requiredWorkflowTools: readonly string[];
  forbiddenWorkflowTools: readonly { name: string; reason: string }[];
  promptObligations: readonly string[];
  promptContext: UnitPromptContextContract;
  validationRules: readonly string[];
  closeoutTools: readonly string[];
  sourceObservations: UnitSourceObservationContract;
  artifacts: {
    inline: readonly ArtifactKey[];
    excerpt: readonly ArtifactKey[];
    onDemand: readonly ArtifactKey[];
  };
}

export interface UnitPromptContextContract {
  unitType: string;
  contextMode: ContextModePolicy;
  toolsPolicy: ToolsPolicy;
  obligations: readonly string[];
  sourceObservations: UnitSourceObservationContract;
  artifacts: {
    inline: readonly ArtifactKey[];
    excerpt: readonly ArtifactKey[];
    onDemand: readonly ArtifactKey[];
    computed: readonly ComputedArtifactId[];
    prepend: readonly ComputedArtifactId[];
  };
  maxSystemPromptChars: number;
}

export type UnitSourceObservationContract =
  | { mode: "none" }
  | {
      mode: "whole-file-active-unit";
      seedFields: readonly ["task.files", "task.inputs"];
      excludedFields: readonly ["expectedOutput"];
      maxBytes: number;
      maxLines: number;
    };

export type ToolContractResult =
  | { ok: true; contract: UnitToolContract }
  | { ok: false; reason: "unknown-unit-type" | "missing-closeout-tool"; detail: string };

export type UnitContextContractResult =
  | { ok: true; contract: UnitPromptContextContract }
  | { ok: false; reason: "unknown-unit-type"; detail: string };

export interface UnitWorkflowDispatchReadinessInput {
  provider?: string;
  unitType: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  surface?: string;
  authMode?: WorkflowCapabilityOptions["authMode"];
  baseUrl?: string;
  activeTools?: string[];
}

export interface WorkflowDispatchModelContext {
  provider?: string;
  baseUrl?: string;
}

export interface UnitWorkflowDispatchReadinessForModelInput
  extends Omit<UnitWorkflowDispatchReadinessInput, "provider" | "authMode" | "baseUrl"> {
  model?: WorkflowDispatchModelContext | null;
  fallbackModel?: WorkflowDispatchModelContext | null;
  getProviderAuthMode?: (provider: string) => WorkflowCapabilityOptions["authMode"] | undefined;
}

export function compileUnitContextContract(unitType: string): UnitContextContractResult {
  const manifest = resolveManifest(unitType);
  if (!manifest) {
    return {
      ok: false,
      reason: "unknown-unit-type",
      detail: `No Unit manifest is registered for ${unitType}`,
    };
  }
  return { ok: true, contract: buildPromptContextContract(unitType, manifest) };
}

export function getUnitWorkflowDispatchReadinessError(
  input: UnitWorkflowDispatchReadinessInput,
): string | null {
  return getWorkflowTransportSupportError(
    input.provider,
    getRequiredWorkflowToolsForUnit(input.unitType),
    {
      projectRoot: input.projectRoot,
      env: input.env,
      surface: input.surface,
      unitType: input.unitType,
      authMode: input.authMode,
      baseUrl: input.baseUrl,
      activeTools: input.activeTools,
    },
  );
}

export function getUnitWorkflowDispatchReadinessErrorForModel(
  input: UnitWorkflowDispatchReadinessForModelInput,
): string | null {
  const provider = input.model?.provider ?? input.fallbackModel?.provider;
  const baseUrl = input.model?.baseUrl ?? input.fallbackModel?.baseUrl;
  return getUnitWorkflowDispatchReadinessError({
    provider,
    unitType: input.unitType,
    projectRoot: input.projectRoot,
    env: input.env,
    surface: input.surface,
    authMode: provider ? input.getProviderAuthMode?.(provider) : undefined,
    baseUrl,
    activeTools: input.activeTools,
  });
}

export function compileUnitToolContract(unitType: string): ToolContractResult {
  const manifest = resolveManifest(unitType);
  const surfaceContract = getUnitToolSurfaceContract(unitType);
  if (!manifest) {
    return {
      ok: false,
      reason: "unknown-unit-type",
      detail: `No Unit manifest is registered for ${unitType}`,
    };
  }

  const requiredWorkflowTools = getRequiredWorkflowToolsForUnit(unitType);
  const forbiddenWorkflowTools = Object.entries(surfaceContract?.forbiddenGsdTools ?? {})
    .map(([name, reason]) => ({ name, reason }));
  const closeoutTools = requiredWorkflowTools.filter((tool) =>
    /^gsd_(?:task|slice|milestone|complete|validate|save|summary|uat)/.test(tool),
  );

  if (requiresCloseoutTool(unitType) && closeoutTools.length === 0) {
    return {
      ok: false,
      reason: "missing-closeout-tool",
      detail: `${unitType} has no closeout workflow tool`,
    };
  }

  const promptContext = buildPromptContextContract(unitType, manifest);

  return {
    ok: true,
    contract: {
      unitType,
      contextMode: manifest.contextMode,
      toolsPolicy: manifest.tools,
      requiredWorkflowTools,
      forbiddenWorkflowTools,
      promptObligations: promptContext.obligations,
      promptContext,
      validationRules: [
        "unit-manifest-present",
        "workflow-tool-surface-present",
        ...(requiresCloseoutTool(unitType) ? ["closeout-tool-present"] : []),
        ...(unitType === "execute-task" ? ["source-observation-contract-present"] : []),
      ],
      closeoutTools,
      sourceObservations: promptContext.sourceObservations,
      artifacts: {
        inline: promptContext.artifacts.inline,
        excerpt: promptContext.artifacts.excerpt,
        onDemand: promptContext.artifacts.onDemand,
      },
    },
  };
}

function buildPromptContextContract(
  unitType: string,
  manifest: UnitContextManifest,
): UnitPromptContextContract {
  const sourceObservations = sourceObservationContractForUnit(unitType);
  return {
    unitType,
    contextMode: manifest.contextMode,
    toolsPolicy: manifest.tools,
    obligations: promptContextObligations(manifest, sourceObservations),
    sourceObservations,
    artifacts: {
      inline: manifest.artifacts.inline,
      excerpt: manifest.artifacts.excerpt,
      onDemand: manifest.artifacts.onDemand,
      computed: manifest.artifacts.computed ?? [],
      prepend: manifest.prepend ?? [],
    },
    maxSystemPromptChars: manifest.maxSystemPromptChars,
  };
}

function promptContextObligations(
  manifest: UnitContextManifest,
  sourceObservations: UnitSourceObservationContract,
): string[] {
  const obligations = [
    `context-mode:${manifest.contextMode}`,
    `tools-policy:${manifest.tools.mode}`,
    artifactObligation("context-inline", manifest.artifacts.inline),
    artifactObligation("context-excerpt", manifest.artifacts.excerpt),
    artifactObligation("context-on-demand", manifest.artifacts.onDemand),
  ];
  if (sourceObservations.mode !== "none") {
    obligations.push(`source-observations:${sourceObservations.mode}`);
  }
  return obligations;
}

function artifactObligation(label: string, artifacts: readonly ArtifactKey[]): string {
  return `${label}:${artifacts.length > 0 ? artifacts.join(",") : "none"}`;
}

function sourceObservationContractForUnit(unitType: string): UnitSourceObservationContract {
  if (unitType !== "execute-task") return { mode: "none" };
  return {
    mode: "whole-file-active-unit",
    seedFields: ["task.files", "task.inputs"],
    excludedFields: ["expectedOutput"],
    maxBytes: WHOLE_FILE_OBSERVATION_MAX_BYTES,
    maxLines: WHOLE_FILE_OBSERVATION_MAX_LINES,
  };
}

function requiresCloseoutTool(unitType: string): boolean {
  return /^(execute-task|reactive-execute|complete-slice|validate-milestone|complete-milestone|run-uat|gate-evaluate)$/.test(unitType);
}
