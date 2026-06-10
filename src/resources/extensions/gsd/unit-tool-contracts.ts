// Project/App: gsd-pi
// File Purpose: Unit-to-tool contract views derived from the Unit Registry (ADR-033).
//
// The contract data lives in unit-registry.ts (one Unit Descriptor per unit
// type). This file keeps the established import surface: the derived
// `UNIT_TOOL_CONTRACTS` table and its accessor functions are unchanged for
// consumers.

import {
  UNIT_REGISTRY,
  type UnitToolSurfaceContract,
  type UnitWorkflowToolName,
} from "./unit-registry.js";

export {
  RUN_UAT_WORKFLOW_TOOL_NAMES,
  RUN_UAT_READ_ONLY_TOOL_NAMES,
  RUN_UAT_BROWSER_TOOL_NAMES,
  type UnitToolSurfaceContract,
  type UnitWorkflowToolName,
  type UnitGsdToolName,
} from "./unit-registry.js";

export const RUN_UAT_TOOL_PRESENTATION_PLAN_ID = "run-uat/default-v1";

export const UNIT_TOOL_CONTRACTS: Record<string, UnitToolSurfaceContract> = Object.fromEntries(
  Object.entries(UNIT_REGISTRY).flatMap(([unitType, descriptor]) =>
    descriptor.toolContract ? [[unitType, descriptor.toolContract]] : [],
  ),
);

export const AUTO_UNIT_SCOPED_TOOLS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(UNIT_TOOL_CONTRACTS).map(([unitType, contract]) => [unitType, contract.allowedGsdTools]),
);

export function getUnitToolSurfaceContract(unitType: string): UnitToolSurfaceContract | undefined {
  return UNIT_TOOL_CONTRACTS[unitType];
}

export function getRequiredWorkflowToolsForUnit(unitType: string): UnitWorkflowToolName[] {
  return [...(UNIT_TOOL_CONTRACTS[unitType]?.requiredWorkflowTools ?? [])];
}

export function getForbiddenGsdToolReason(unitType: string, toolName: string): string | undefined {
  return UNIT_TOOL_CONTRACTS[unitType]?.forbiddenGsdTools?.[toolName];
}
