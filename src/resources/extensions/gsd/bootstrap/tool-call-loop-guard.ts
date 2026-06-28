/**
 * Tool-call loop guard.
 *
 * Detects when a model calls the same tool with identical arguments
 * repeatedly within a single agent turn. Works in both auto-mode and
 * interactive sessions by hooking into the `tool_call` event, which
 * fires before execution and can block the call.
 *
 * The guard uses a sliding window: it tracks the last N tool signatures
 * and blocks when the same signature appears more than MAX_CONSECUTIVE
 * times in a row. Resets on each agent turn (session_start, agent_end)
 * and when a different tool call breaks the streak.
 *
 * A second, independent check (#783 Brief C) tracks per-tool-name call
 * counts within a turn regardless of args. This catches improvisation
 * loops where the model attempts the same missing workflow tool through
 * varied surfaces (bash → `node -e` → CLI), each with a different
 * signature, so the identical-args streak never trips. Whichever guard
 * trips first blocks.
 */

import { createHash } from "node:crypto";
import { INHERENTLY_REPEATABLE_TOOL_SET } from "./core-session-tools.js";

const MAX_CONSECUTIVE_IDENTICAL_CALLS = 4;

/** Interactive/user-facing tools where even 1 duplicate is confusing. */
const STRICT_LOOP_TOOLS = new Set(["ask_user_questions"]);
const MAX_CONSECUTIVE_STRICT = 1;

/**
 * Per-turn cap on calls to the SAME tool name, regardless of args (#783).
 *
 * General-purpose execution tools are routinely called many times per turn
 * (touching multiple files, running several commands), so they get a higher
 * ceiling. Everything else — workflow one-shot tools (e.g. gsd_complete_milestone)
 * and any non-allowlisted tool — gets the default cap. The default is generous
 * enough to absorb legitimate retries but catches the reported improvisation
 * loop (~51 calls) well before a cost spike.
 */
const PER_TOOL_DEFAULT_CAP = 6;
const PER_TOOL_REPEATABLE_CAP = 15;

let consecutiveCount = 0;
let lastSignature = "";
let lastToolName = "";
let enabled = true;

/** Per-tool-name call counts within the current turn (#783 Brief C). */
const perToolCounts = new Map<string, number>();

/** Hash tool name + args into a compact signature for comparison. */
function hashToolCall(toolName: string, args: Record<string, unknown>): string {
  const h = createHash("sha256");
  h.update(toolName);
  // Sort keys recursively for deterministic hashing regardless of object key order
  h.update(JSON.stringify(args, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort().reduce<Record<string, unknown>>((o, k) => {
          o[k] = value[k];
          return o;
        }, {})
      : value
  ));
  return h.digest("hex").slice(0, 16);
}

/**
 * Record a tool call and check if it should be blocked.
 *
 * Returns `{ block: false }` for allowed calls.
 * Returns `{ block: true, reason }` when the loop threshold is exceeded.
 *
 * Two independent guards run; whichever trips first blocks:
 *  1. Identical-signature streak (MAX_CONSECUTIVE_IDENTICAL_CALLS, strict for
 *     ask_user_questions).
 *  2. Per-tool-name cap (PER_TOOL_DEFAULT_CAP / PER_TOOL_REPEATABLE_CAP),
 *     independent of args — catches improvisation loops (#783).
 */
export function checkToolCallLoop(
  toolName: string,
  args: Record<string, unknown>,
): { block: boolean; reason?: string; count?: number } {
  if (!enabled) return { block: false, count: 0 };

  const sig = hashToolCall(toolName, args);

  if (sig === lastSignature) {
    consecutiveCount++;
  } else {
    consecutiveCount = 1;
    lastSignature = sig;
    lastToolName = toolName;
  }

  // ── Guard 1: identical-signature streak ──
  const threshold = STRICT_LOOP_TOOLS.has(toolName)
    ? MAX_CONSECUTIVE_STRICT
    : MAX_CONSECUTIVE_IDENTICAL_CALLS;

  if (consecutiveCount > threshold) {
    return {
      block: true,
      reason:
        `Tool loop detected (identical args): ${toolName} called ${consecutiveCount} times ` +
        `with identical arguments. Blocking to prevent infinite loop. ` +
        `Try a different approach or modify your arguments.`,
      count: consecutiveCount,
    };
  }

  // ── Guard 2: per-tool-name cap, independent of args (#783 Brief C) ──
  // Catches improvisation loops where the same tool is invoked many times with
  // varied args (e.g. retrying a missing workflow tool via bash/node -e/CLI).
  const perToolCount = (perToolCounts.get(toolName) ?? 0) + 1;
  perToolCounts.set(toolName, perToolCount);
  const perToolCap = INHERENTLY_REPEATABLE_TOOL_SET.has(toolName)
    ? PER_TOOL_REPEATABLE_CAP
    : PER_TOOL_DEFAULT_CAP;

  if (perToolCount > perToolCap) {
    return {
      block: true,
      reason:
        `Tool loop detected (repeated tool): ${toolName} called ${perToolCount} times ` +
        `this turn (cap ${perToolCap}). Blocking to prevent infinite loop. ` +
        `The tool may be unavailable or failing repeatedly — try a different approach.`,
      count: perToolCount,
    };
  }

  return { block: false, count: consecutiveCount };
}

/** Reset the guard state. Call at agent turn boundaries. */
export function resetToolCallLoopGuard(): void {
  consecutiveCount = 0;
  lastSignature = "";
  lastToolName = "";
  enabled = true;
  perToolCounts.clear();
}

/** Disable the guard (e.g. during shutdown). */
export function disableToolCallLoopGuard(): void {
  enabled = false;
  consecutiveCount = 0;
  lastSignature = "";
  lastToolName = "";
  perToolCounts.clear();
}

/** Get current consecutive count for diagnostics. */
export function getToolCallLoopCount(): number {
  return consecutiveCount;
}

/**
 * Get the per-tool-name call count for the current turn (#783 Brief C).
 * Returns 0 for tools not yet called. Diagnostic only.
 */
export function getToolCallCountForTool(toolName: string): number {
  return perToolCounts.get(toolName) ?? 0;
}
