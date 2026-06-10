// Project/App: gsd-pi
// File Purpose: Tool Contract module's runtime face — verify the live SDK tool surface covers a Unit's required workflow tools.

import { mcpToolMatchesBaseName } from "./mcp-tool-name.js";
import { getRequiredWorkflowToolsForUnit } from "./unit-tool-contracts.js";
import { isWorkflowToolSurfaceName } from "./workflow-tool-surface.js";

/**
 * Stable phrase recognized as transient by auto-tool-tracking's
 * isToolUnavailableError and error-classifier's transient buckets —
 * keep the three in sync.
 */
export const TOOL_SURFACE_NOT_READY = "workflow tool surface not ready";

export interface LiveToolSurfaceObservation {
  /** Tool names the session reported at init (MCP tools appear as mcp__<server>__<tool>). */
  tools: readonly string[];
  /** MCP server connection statuses the session reported at init. */
  mcpServers: readonly { name: string; status: string }[];
}

/**
 * Verify the live tool surface observed at SDK session init covers the Unit's
 * required workflow tools. Complements the static pre-dispatch gate
 * (getWorkflowTransportSupportError), which only proves the MCP launch config
 * is discoverable — the workflow server connects asynchronously after session
 * start, so the static gate cannot see whether the tools actually registered.
 *
 * Returns a transient, recovery-classifiable error (kind tool-unavailable →
 * retry) when the workflow server failed or has not yet registered a required
 * tool, so dispatch aborts before the first model turn instead of letting the
 * Unit improvise around "No such tool available". Returns null when no
 * workflow server is part of this session (native tool path), when the Unit
 * requires no workflow tools, or when the surface is ready.
 */
export function getToolSurfaceReadinessError(input: {
  unitType: string | undefined;
  workflowServerName: string | undefined;
  observation: LiveToolSurfaceObservation;
}): string | null {
  const { unitType, workflowServerName, observation } = input;
  if (!unitType || !workflowServerName) return null;

  const required = getRequiredWorkflowToolsForUnit(unitType).filter(isWorkflowToolSurfaceName);
  if (required.length === 0) return null;

  const server = observation.mcpServers.find((entry) => entry.name === workflowServerName);
  if (!server) return null;

  const missing = required.filter(
    (tool) => !observation.tools.some((name) => name === tool || mcpToolMatchesBaseName(name, tool)),
  );
  if (missing.length === 0) return null;

  const serverDetail =
    server.status === "connected"
      ? `MCP server "${workflowServerName}" is connected but has not registered`
      : `MCP server "${workflowServerName}" status is "${server.status}" and it has not registered`;
  return `${TOOL_SURFACE_NOT_READY} for ${unitType}: ${serverDetail}: ${missing.join(", ")}`;
}
