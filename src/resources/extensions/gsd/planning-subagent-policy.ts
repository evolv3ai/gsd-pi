import { CONFIGURABLE_PLANNING_SUBAGENT_UNITS, type GSDPreferences } from "./preferences-types.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import type { ToolsPolicy } from "./unit-context-manifest.js";

const CONFIGURABLE_UNITS = new Set<string>(CONFIGURABLE_PLANNING_SUBAGENT_UNITS);

function configuredAllowedSubagents(
  unitType: string,
  preferences: GSDPreferences | null | undefined,
): readonly string[] {
  if (!CONFIGURABLE_UNITS.has(unitType)) return [];
  return preferences?.planning_subagents?.[
    unitType as keyof NonNullable<GSDPreferences["planning_subagents"]>
  ]?.allowed ?? [];
}

function mergeAllowedSubagents(
  current: readonly string[],
  configured: readonly string[],
): readonly string[] {
  return Array.from(new Set([...current, ...configured]));
}

export function applyPlanningSubagentPreferences(
  unitType: string,
  policy: ToolsPolicy | null | undefined,
  preferences: GSDPreferences | null | undefined,
): ToolsPolicy | null | undefined {
  if (!policy) return policy;
  const configured = configuredAllowedSubagents(unitType, preferences);
  if (configured.length === 0) return policy;

  if (policy.mode === "planning") {
    return {
      mode: "planning-dispatch",
      allowedSubagents: mergeAllowedSubagents([], configured),
    };
  }

  if (policy.mode === "planning-dispatch") {
    return {
      ...policy,
      allowedSubagents: mergeAllowedSubagents(policy.allowedSubagents, configured),
    };
  }

  return policy;
}

export function resolveEffectivePlanningToolsPolicy(
  unitType: string,
  policy: ToolsPolicy | null | undefined,
  basePath?: string,
): ToolsPolicy | null | undefined {
  if (!basePath) return policy;
  const preferences = loadEffectiveGSDPreferences(basePath)?.preferences;
  return applyPlanningSubagentPreferences(unitType, policy, preferences);
}
