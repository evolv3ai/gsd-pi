// Project/App: gsd-pi
// File Purpose: GSD-facing face over the shared @gsd/pi-ai MCP tool-name helpers.

import { parseMcpToolName as parsePiAiMcpToolName, stripMcpToolPrefix } from "@gsd/pi-ai";

const MCP_TOOL_PREFIX = "mcp__";

export interface ParsedMcpToolName {
  serverName: string;
  toolName: string;
}

export function parseMcpToolName(toolName: string): ParsedMcpToolName | null {
  const parsed = parsePiAiMcpToolName(toolName);
  return parsed ? { serverName: parsed.server, toolName: parsed.tool } : null;
}

export { stripMcpToolPrefix };

export function toMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

export function toMcpWildcardToolName(serverName: string): string {
  return toMcpToolName(serverName, "*");
}

export function mcpToolMatchesBaseName(toolName: string, baseName: string): boolean {
  return parseMcpToolName(toolName)?.toolName === baseName;
}
