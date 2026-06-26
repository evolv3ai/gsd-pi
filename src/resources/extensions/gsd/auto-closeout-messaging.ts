// Project/App: gsd-pi
// File Purpose: Rewrite premature unit "complete" chat lines before GSD post-unit verification.

/**
 * Auto-mode owns the authoritative "unit complete" signal (finalize/stopAuto).
 * Agents may still emit legacy closeout lines after completion tools succeed;
 * rewrite those for transcript clarity until post-unit verification passes.
 */

const CLOSEOUT_LINE_REWRITES: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /^Milestone\s+(M\d+[A-Z0-9-]*)\s+complete\.?$/i,
    replacement: "Milestone $1 closeout submitted.",
  },
  {
    pattern: /^Milestone\s+(M\d+[A-Z0-9-]*)\s+is\s+already\s+complete\.?$/i,
    replacement: "Milestone $1 closeout already recorded.",
  },
  {
    pattern: /^Slice\s+(S\d+[A-Z0-9-]*)\s+complete\.?$/i,
    replacement: "Slice $1 closeout submitted.",
  },
  {
    pattern: /^Task\s+(T\d+[A-Z0-9-]*)\s+complete\.?$/i,
    replacement: "Task $1 closeout submitted.",
  },
  {
    pattern: /^UAT\s+(S\d+[A-Z0-9-]*)\s+complete\.?$/i,
    replacement: "UAT $1 results submitted.",
  },
  {
    pattern: /^Quick\s+task\s+(\d+)\s+complete\.?$/i,
    replacement: "Quick task $1 closeout submitted.",
  },
  {
    pattern: /^Triage\s+complete\.?$/i,
    replacement: "Triage closeout submitted.",
  },
];

export function rewritePrematureCloseoutLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  for (const { pattern, replacement } of CLOSEOUT_LINE_REWRITES) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, replacement);
    }
  }
  return line;
}

export function rewritePrematureCloseoutText(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  let changed = false;
  const rewritten = lines.map((line) => {
    const next = rewritePrematureCloseoutLine(line);
    if (next !== line) changed = true;
    return next;
  });
  return changed ? rewritten.join("\n") : text;
}

function rewriteAssistantMessageContent(content: unknown): boolean {
  if (typeof content === "string") {
    const rewritten = rewritePrematureCloseoutText(content);
    return rewritten !== content;
  }
  if (!Array.isArray(content)) return false;

  let changed = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const part = block as { type?: unknown; text?: unknown };
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const rewritten = rewritePrematureCloseoutText(part.text);
    if (rewritten !== part.text) {
      part.text = rewritten;
      changed = true;
    }
  }
  return changed;
}

/** Rewrite assistant closeout lines on message_end during auto-mode. */
export function sanitizePrematureCloseoutMessageEnd(event: { message?: unknown } | null | undefined): void {
  const message = event?.message as { role?: unknown; content?: unknown } | undefined;
  if (!message || message.role !== "assistant") return;
  rewriteAssistantMessageContent(message.content);
}
