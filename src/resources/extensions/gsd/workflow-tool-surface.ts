// Project/App: gsd-pi
// File Purpose: Adapts shared workflow tool contracts into the extension runtime surface.

import {
  CANONICAL_WORKFLOW_TOOL_NAMES as CONTRACT_CANONICAL_WORKFLOW_TOOL_NAMES,
  WORKFLOW_TOOL_ALIAS_NAMES as CONTRACT_WORKFLOW_TOOL_ALIAS_NAMES,
  WORKFLOW_TOOL_CONTRACTS as CONTRACT_WORKFLOW_TOOL_CONTRACTS,
  WORKFLOW_TOOL_NAMES as CONTRACT_WORKFLOW_TOOL_NAMES,
} from "@opengsd/contracts";
import { stripMcpToolPrefix } from "./mcp-tool-name.js";

export interface WorkflowToolAliasPair {
  canonical: string;
  alias: string;
}

export const WORKFLOW_TOOL_CONTRACTS = CONTRACT_WORKFLOW_TOOL_CONTRACTS;

export const CANONICAL_WORKFLOW_TOOL_NAMES = CONTRACT_CANONICAL_WORKFLOW_TOOL_NAMES;
export const WORKFLOW_TOOL_ALIAS_NAMES = CONTRACT_WORKFLOW_TOOL_ALIAS_NAMES;
export const DB_WORKFLOW_TOOL_NAMES = CONTRACT_WORKFLOW_TOOL_NAMES;

export const WORKFLOW_TOOL_ALIAS_PAIRS: readonly WorkflowToolAliasPair[] =
  WORKFLOW_TOOL_CONTRACTS.flatMap((tool) =>
    tool.aliases.map((alias) => ({ canonical: tool.canonicalName, alias })),
  );

export const WORKFLOW_TOOL_ALIAS_TO_CANONICAL: Readonly<Record<string, string>> =
  Object.fromEntries(WORKFLOW_TOOL_ALIAS_PAIRS.map(({ alias, canonical }) => [alias, canonical]));

export const WORKFLOW_MCP_ADAPTER_TOOL_NAMES = [
  "gsd_cancel",
  "gsd_captures",
  "ask_user_questions",
  "gsd_doctor",
  "gsd_execute",
  "gsd_graph",
  "gsd_history",
  "gsd_knowledge",
  "gsd_progress",
  "gsd_query",
  "gsd_result",
  "gsd_resolve_blocker",
  "gsd_roadmap",
  "gsd_status",
] as const;

/** Session-orchestration tools exposed by the workflow MCP adapter alongside the contract tools. */
export type WorkflowMcpAdapterToolName = (typeof WORKFLOW_MCP_ADAPTER_TOOL_NAMES)[number];

export const WORKFLOW_TOOL_SURFACE_NAMES = [
  ...WORKFLOW_MCP_ADAPTER_TOOL_NAMES,
  ...DB_WORKFLOW_TOOL_NAMES,
] as readonly string[];

const WORKFLOW_TOOL_SURFACE_NAME_SET = new Set(WORKFLOW_TOOL_SURFACE_NAMES);

export { stripMcpToolPrefix } from "./mcp-tool-name.js";

export function canonicalWorkflowSurfaceToolName(toolName: string): string {
  const baseName = stripMcpToolPrefix(toolName);
  return WORKFLOW_TOOL_ALIAS_TO_CANONICAL[baseName] ?? baseName;
}

export function isWorkflowSurfaceAliasTool(toolName: string): boolean {
  const baseName = stripMcpToolPrefix(toolName);
  return WORKFLOW_TOOL_ALIAS_TO_CANONICAL[baseName] !== undefined;
}

export function isWorkflowToolSurfaceName(toolName: string): boolean {
  return WORKFLOW_TOOL_SURFACE_NAME_SET.has(stripMcpToolPrefix(toolName));
}

export function aliasesForWorkflowTool(canonicalName: string): readonly string[] {
  return WORKFLOW_TOOL_CONTRACTS.find((tool) => tool.canonicalName === canonicalName)?.aliases ?? [];
}
