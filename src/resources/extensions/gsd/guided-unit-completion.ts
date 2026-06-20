// Project/App: gsd-pi
// File Purpose: Recover guided-unit completion signals that did not produce expected tool/file evidence.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  clearPathCache,
  relMilestoneFile,
  resolveMilestoneFile,
  resolveMilestonePath,
} from "./paths.js";
import {
  _getPendingAutoStart,
  deletePendingAutoStart,
  hasPendingAutoStart,
} from "./pending-auto-start.js";
import { logWarning } from "./workflow-logger.js";

// #4573: cap for how many times we nudge the LLM after a premature ready
// phrase before giving up and asking the user to re-run /gsd.
const MAX_READY_REJECTS = 2;

// #4573: matches the canonical ready phrase the discuss prompt asks the LLM
// to emit. Accepts any M-prefixed milestone ID (three digits + optional
// suffix) with optional trailing punctuation.
const READY_PHRASE_RE = /\bMilestone\s+M\d{3}[A-Z0-9-]*\s+ready\.?/i;

const emptyTurnCounterByBase = new Map<string, number>();
const MAX_EMPTY_TURN_RETRIES = 2;

// Phrases that indicate the LLM is about to do something but has not yet.
// Kept tight to avoid flagging legitimate narration like "I'll wait for your answer."
//
// "make" was previously in the verb list but matches conversational meta phrases
// like "Let me make sure I understand…" which are NOT action announcements —
// removed to prevent the empty-turn nudge from auto-replying to user questions
// in discuss flows.
const COMMIT_INTENT_RE =
  /\b(?:I['’]ll|I will|Next,? I['’]ll|Now I['’]ll|Let me|I['’]m going to|I am going to)\s+(?:now\s+)?(?:write|create|call|invoke|update|add|run|execute|generate|produce|emit|compose|implement|save|apply|commit)\b/i;

/**
 * Extract the concatenated text content from an assistant message, whether it
 * stores content as a string or as an array of text blocks.
 */
function extractAssistantText(msg: any): string {
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Return true if the assistant message contains any tool-use block.
 *
 * The canonical pi-ai `AssistantMessage.content` (see packages/pi-ai/src/types.ts)
 * uses `type: "toolCall"` and `type: "serverToolUse"` for tool invocations —
 * every provider (anthropic-direct, claude-code-cli, openai, etc.) normalizes
 * incoming tool blocks into these two shapes before they reach guided-flow.
 *
 * The Anthropic API wire shape `"tool_use"` / `"server_tool_use"` does NOT appear
 * in the internal AssistantMessage — those literals are only used when sending
 * messages back out to the Anthropic API. Matching them here was a latent bug:
 * `hasToolUse` returned `false` for every real tool call, which let the
 * empty-turn nudge fire and pre-empt MCP tools that block on the user
 * (e.g. `ask_user_questions`). See investigation in PR for #4658.
 */
function hasToolUse(msg: any): boolean {
  if (!msg) return false;
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b: any) =>
      b &&
      typeof b === "object" &&
      (b.type === "toolCall" || b.type === "serverToolUse"),
  );
}

/**
 * #4573 — Detect and recover from the "ready phrase without files" failure mode.
 *
 * When the LLM emits "Milestone {{id}} ready." but has not written the
 * milestone CONTEXT/ROADMAP artifacts, `checkAutoStartAfterDiscuss()` silently
 * returns false and the next /gsd invocation loops into the "All milestones
 * complete" warning.
 *
 * This function, called from `handleAgentEnd` after `checkAutoStartAfterDiscuss`
 * returns false, pattern-matches the ready phrase on the last assistant message.
 * If it fired AND neither the canonical M###-CONTEXT.md/M###-ROADMAP.md nor
 * legacy CONTEXT.md/ROADMAP.md files exist, it:
 *   1. Notifies the user that the signal was rejected.
 *   2. Injects a system message via `pi.sendMessage(..., {triggerTurn:true})`
 *      telling the LLM the signal was premature and to emit the writes now.
 *   3. Caps at `MAX_READY_REJECTS` per-entry; beyond that, gives up and asks
 *      the user to re-run /gsd.
 *
 * Returns true when a nudge (or give-up) was emitted, signaling the caller to
 * skip `resolveAgentEnd`.
 */
export function maybeHandleReadyPhraseWithoutFiles(
  event: { messages: any[] },
  lookupBasePath?: string,
): boolean {
  const entry = _getPendingAutoStart(lookupBasePath);
  if (!entry) return false;
  const { ctx, pi, basePath, milestoneId } = entry;

  // Gate: last assistant message must contain the ready phrase
  const lastMsg = event.messages[event.messages.length - 1];
  const text = extractAssistantText(lastMsg);
  if (!READY_PHRASE_RE.test(text)) return false;

  // Bust paths.ts cached dir listings before checking for fresh writes. The
  // LLM's Write tool calls do not invalidate paths.ts caches, so a stale
  // listing taken before the milestone dir or its CONTEXT/ROADMAP files
  // existed would falsely report the artifacts as missing and trigger the
  // 3-strike "ready without files" abort even though the writes succeeded.
  clearPathCache();

  // Gate: artifacts must still be missing — if they exist, the happy path
  // already fired and we have nothing to do.
  const contextFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
  const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (contextFile || roadmapFile) return false;

  // Diagnostic: when the cached resolver reports both files missing, also probe
  // the canonical paths with uncached existsSync so we can tell whether the
  // recovery is firing on real-missing files or a path-resolution miss
  // (basePath/symlink mismatch, stale cache despite agent-end-recovery flush,
  // legacy descriptor dir not matching, etc.).
  try {
    const mDir = resolveMilestonePath(basePath, milestoneId);
    const canonicalCtx = mDir ? join(mDir, `${milestoneId}-CONTEXT.md`) : null;
    const canonicalRoadmap = mDir ? join(mDir, `${milestoneId}-ROADMAP.md`) : null;
    logWarning(
      "guided",
      `ready-phrase-reject diagnostic mid=${milestoneId} basePath=${basePath} ` +
      `mDir=${mDir ?? "null"} ` +
      `canonical-ctx=${canonicalCtx ?? "null"} ctx-exists=${canonicalCtx ? existsSync(canonicalCtx) : "n/a"} ` +
      `canonical-roadmap=${canonicalRoadmap ?? "null"} roadmap-exists=${canonicalRoadmap ? existsSync(canonicalRoadmap) : "n/a"}`,
    );
  } catch (e) {
    logWarning("guided", `ready-phrase-reject diagnostic failed: ${(e as Error).message}`);
  }

  entry.readyRejectCount = (entry.readyRejectCount ?? 0) + 1;

  if (entry.readyRejectCount > MAX_READY_REJECTS) {
    // Give up: clear state and tell the user to re-run /gsd. Avoids an
    // infinite nudge loop when the LLM never produces the writes.
    deletePendingAutoStart(basePath);
    ctx.ui.notify(
      `Milestone ${milestoneId}: LLM signaled "ready" ${entry.readyRejectCount} times without writing files. ` +
      `Stopping auto-nudge. Run /gsd to try again.`,
      "error",
    );
    return true;
  }

  const contextRel = relMilestoneFile(basePath, milestoneId, "CONTEXT");
  const roadmapRel = relMilestoneFile(basePath, milestoneId, "ROADMAP");
  ctx.ui.notify(
    `Milestone ${milestoneId}: "ready" signal rejected — ${contextRel} and ${roadmapRel} are missing. Asking the LLM to complete the writes.`,
    "warning",
  );

  const nudge =
    `You emitted "Milestone ${milestoneId} ready." but neither ` +
    `${contextRel} nor ${roadmapRel} exists on disk. ` +
    `The ready phrase is a POST-WRITE signal and has been rejected. ` +
    `In this turn: (1) write PROJECT.md, REQUIREMENTS.md, and the milestone ` +
    `CONTEXT.md, (2) call gsd_plan_milestone, then (3) emit the ready phrase. ` +
    `Do not describe these steps — execute them as tool calls. ` +
    `This is retry ${entry.readyRejectCount}/${MAX_READY_REJECTS}; further ` +
    `premature signals will clear the session.`;

  try {
    pi.sendMessage(
      { customType: "gsd-ready-no-files", content: nudge, display: false },
      { triggerTurn: true },
    );
  } catch (e) {
    logWarning("guided", `ready-phrase nudge sendMessage failed: ${(e as Error).message}`);
    return false;
  }
  return true;
}

/**
 * Reset the empty-turn counter for a basePath after a successful tool-use turn.
 * Called from handleAgentEnd when the last message contains tool_use blocks.
 */
export function resetEmptyTurnCounter(basePath?: string): void {
  if (basePath) emptyTurnCounterByBase.delete(basePath);
  else emptyTurnCounterByBase.clear();
}

export function maybeHandleEmptyIntentTurn(
  event: { messages: any[] },
  isAuto: boolean,
  lookupBasePath?: string,
): boolean {
  // Gate: only fire when there is system-driven work in flight. Interactive
  // /gsd discuss (user-driven) produces legitimate text-only turns.
  if (!isAuto && !hasPendingAutoStart(lookupBasePath)) return false;

  const lastMsg = event.messages[event.messages.length - 1];
  if (!lastMsg) return false;
  if (hasToolUse(lastMsg)) return false;

  const text = extractAssistantText(lastMsg).trim();
  if (!text) return false;

  // Skip if the LLM is emitting the ready phrase — that is the ready-no-files
  // path, handled by maybeHandleReadyPhraseWithoutFiles.
  if (READY_PHRASE_RE.test(text)) return false;

  // Skip if the LLM is clearly handing back to the user. Discuss flows
  // often pose a question and follow it with a conditional intent on the
  // same line ("Did I capture that correctly? If so, I'll write the
  // requirements."). A line-trailing `?` check misses these because the
  // line ends in `.`. Match any sentence-terminating `?` (followed by
  // whitespace or end-of-text) — false negatives here auto-reply to the
  // user, which is a much worse failure mode than a missed nudge.
  if (/\?(?:\s|$)/.test(text)) return false;

  // Must contain a commit-intent phrase — this is the stall we care about.
  if (!COMMIT_INTENT_RE.test(text)) return false;

  // Resolve the target basePath + pi for injection. Prefer the pending
  // autostart entry (discuss flow); otherwise we cannot inject.
  const entry = _getPendingAutoStart(lookupBasePath);
  if (!entry) return false;
  const { ctx, pi, basePath } = entry;

  const count = (emptyTurnCounterByBase.get(basePath) ?? 0) + 1;
  emptyTurnCounterByBase.set(basePath, count);

  if (count > MAX_EMPTY_TURN_RETRIES) {
    ctx.ui.notify(
      `Empty-turn recovery: LLM announced intent ${count} times without calling any tool. ` +
      `Stopping auto-nudge.`,
      "error",
    );
    return false; // let the normal flow resolve/pause the unit
  }

  ctx.ui.notify(
    `Empty-turn detected: LLM announced intent but called no tool. Prompting it to execute.`,
    "info",
  );

  const nudge =
    `Your last turn announced an action (e.g. "I'll write…" or "Let me call…") ` +
    `but contained no tool call. The system records zero tool-use blocks for ` +
    `that turn. Execute the announced action NOW as a tool call in this turn. ` +
    `Do not describe it again. Retry ${count}/${MAX_EMPTY_TURN_RETRIES}.`;

  try {
    pi.sendMessage(
      { customType: "gsd-empty-turn-recovery", content: nudge, display: false },
      { triggerTurn: true },
    );
  } catch (e) {
    logWarning("guided", `empty-turn nudge sendMessage failed: ${(e as Error).message}`);
    return false;
  }
  return true;
}
