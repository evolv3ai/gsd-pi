// Project/App: gsd-pi
// File Purpose: Typed contract for which tool lifecycle hooks fire under which
// engine, plus the single seam for tool-name normalization.
//
// ── Why this contract exists ────────────────────────────────────────────────
// External engines (claude-code-cli) pre-execute tools inside the vendor CLI
// and hand the agent loop a `toolCall.externalResult`. The loop short-circuits
// before `beforeToolCall`/`afterToolCall` ever run for those calls
// (packages/pi-agent-core/src/agent-loop.ts, prepareToolCall: the
// externalResult branch returns an "immediate" outcome before the
// config.beforeToolCall invocation, and "immediate" outcomes skip
// finalizeExecutedToolCall where config.afterToolCall lives).
// `beforeToolCall`/`afterToolCall` are exactly what the extension runner maps
// to the `tool_call`/`tool_result` extension events
// (packages/gsd-agent-core/src/session/agent-session-extensions.ts,
// installAgentToolHooks).
//
// `tool_execution_start` is emitted unconditionally before prepareToolCall
// and `tool_execution_end` after every finalized outcome — immediate or
// executed — so those two are the ONLY tool lifecycle hooks that fire for
// every tool call on every engine.
//
// Consequence: any enforcement attached only to `tool_call` (blocking) or
// `tool_result` (rewriting) is silently dead under external engines. Safety
// enforcement must ride `tool_execution_start`/`tool_execution_end`, or
// mirror across both with toolCallId dedup. See the per-registration contract
// comments in bootstrap/register-hooks.ts for how each registered hook
// honors (or knowingly violates) this contract.

import { stripMcpToolPrefix } from "./mcp-tool-name.js";
import { canonicalWorkflowSurfaceToolName } from "./workflow-tool-surface.js";

/**
 * Tool lifecycle hooks that fire for EVERY tool call on EVERY engine,
 * including external engines (claude-code-cli) that pre-execute tools.
 * Attach safety-critical enforcement and evidence collection here.
 */
export const UNIVERSAL_TOOL_HOOKS = ["tool_execution_start", "tool_execution_end"] as const;

/**
 * Tool lifecycle hooks that fire ONLY for natively executed tools. External
 * engines pre-execute tools (externalResult), short-circuiting the agent
 * loop's beforeToolCall/afterToolCall — so handlers on these events never run
 * for those calls. Blocking guards attached only here are dead under external
 * engines; they need a tool_execution_start mirror to be universal.
 */
export const NATIVE_ONLY_TOOL_HOOKS = ["tool_call", "tool_result"] as const;

export type UniversalToolHook = (typeof UNIVERSAL_TOOL_HOOKS)[number];
export type NativeOnlyToolHook = (typeof NATIVE_ONLY_TOOL_HOOKS)[number];

// Non-tool lifecycle events (session_start, agent_end, message_update, ...)
// are intentionally NOT classified here: they are emitted by the session
// host / extension runner independent of tool execution, so the external
// engine short-circuit above does not apply to them. Only classify events
// whose engine behavior has been verified against the agent loop.

/**
 * Canonical tool name: strips the `mcp__<server>__` prefix when present,
 * nothing else. Use for identity checks against host/native tool names and
 * for any guard that must NOT conflate workflow aliases with their canonical
 * tools (e.g. write gates, evidence keys).
 *
 * Malformed MCP names (empty server or empty tool segment, e.g.
 * `mcp____tool` or `mcp__server__`) are returned unchanged.
 */
export function canonicalToolName(toolName: string): string {
  return stripMcpToolPrefix(toolName);
}

/**
 * Workflow-aware canonical tool name: strips the MCP prefix AND resolves
 * workflow tool aliases to their canonical contract names. Use whenever the
 * name is compared against the workflow tool surface (scoping, presentation,
 * dispatch) — plain {@link canonicalToolName} would miss alias spellings.
 */
export function canonicalWorkflowToolName(toolName: string): string {
  return canonicalWorkflowSurfaceToolName(toolName);
}
