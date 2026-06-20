/**
 * Observation masking for GSD auto-mode sessions.
 *
 * Replaces tool result content older than N turns with a placeholder.
 * Reduces context bloat between compactions with zero LLM overhead.
 * Preserves message ordering, roles, and all assistant/user messages.
 *
 * Operates on provider payloads after convertToLlm:
 *
 * pi-ai Message[] payloads:
 *   - toolResult messages: { role: "toolResult", content: TextContent[] }
 *   - bash results are already converted to: { role: "user", content: [{type:"text",text:"..."}] }
 *     and start with "Ran `" from bashExecutionToText.
 *
 * OpenAI/Codex Responses payloads:
 *   - conversation items live in `input`, not `messages`
 *   - tool results are { type: "function_call_output", output: string | content[] }
 *   - bash results are user items with input_text content starting with "Ran `"
 */

interface MaskableMessage {
  role: string;
  content: unknown;
  type?: string;
  [key: string]: unknown;
}

const MASK_PLACEHOLDER = "[result masked — within summarized history]";
const MASK_CONTENT_BLOCK = [{ type: "text" as const, text: MASK_PLACEHOLDER }];
const RESPONSES_MASK_CONTENT_BLOCK = [{ type: "input_text" as const, text: MASK_PLACEHOLDER }];
const TRUNCATION_MARKER = "\n…[truncated]";

type TextLikeBlock = {
  type?: string;
  text?: unknown;
  [key: string]: unknown;
};

interface ResponsesInputItem {
  role?: string;
  type?: string;
  content?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

function isTextLikeBlock(block: unknown): block is TextLikeBlock {
  return Boolean(block && typeof block === "object" && "text" in block);
}

function firstTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const first = content.find(isTextLikeBlock);
  return typeof first?.text === "string" ? first.text : undefined;
}

function isBashResultText(text: string | undefined): boolean {
  return typeof text === "string" && text.startsWith("Ran `");
}

function findTurnBoundary(messages: MaskableMessage[], keepRecentTurns: number): number {
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // In the LLM payload, genuine user turns have role "user".
    // Tool results have role "toolResult" and are excluded by this check.
    if (m.role === "user") {
      // Skip bash-result user messages (converted from bashExecution) — these aren't real user turns
      if (isBashResultUserMessage(m)) continue;
      turnsSeen++;
      if (turnsSeen >= keepRecentTurns) return i;
    }
  }
  return 0;
}

/**
 * Detect user messages that originated from bashExecution.
 * After convertToLlm, these are {role: "user", content: [{type:"text", text:"Ran `cmd`\n..."}]}.
 * The bashExecutionToText format always starts with "Ran `".
 */
function isBashResultUserMessage(m: MaskableMessage): boolean {
  if (m.role !== "user") return false;
  return isBashResultText(firstTextFromContent(m.content));
}

function isMaskableMessage(m: MaskableMessage): boolean {
  // Tool result messages (role: "toolResult" in pi-ai format)
  if (m.role === "toolResult") return true;
  // Bash-result user messages (converted from bashExecution by convertToLlm)
  if (isBashResultUserMessage(m)) return true;
  return false;
}

export function createObservationMask(keepRecentTurns: number = 8) {
  return (messages: MaskableMessage[]): MaskableMessage[] => {
    const boundary = findTurnBoundary(messages, keepRecentTurns);
    if (boundary === 0) return messages;

    return messages.map((m, i) => {
      if (i >= boundary) return m;
      if (isMaskableMessage(m)) {
        // Content may be string or array of content blocks — always replace with array
        return { ...m, content: MASK_CONTENT_BLOCK };
      }
      return m;
    });
  };
}

function isResponsesBashResultUserItem(item: ResponsesInputItem): boolean {
  if (item.role !== "user") return false;
  return isBashResultText(firstTextFromContent(item.content));
}

function findResponsesTurnBoundary(items: ResponsesInputItem[], keepRecentTurns: number): number {
  let turnsSeen = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.role === "user" && !isResponsesBashResultUserItem(item)) {
      turnsSeen++;
      if (turnsSeen >= keepRecentTurns) return i;
    }
  }
  return 0;
}

/**
 * Observation masking for OpenAI/Codex Responses API payloads.
 *
 * Responses payloads store the conversation under `input` instead of
 * `messages`, with tool results as `function_call_output` items. Keep this
 * separate from createObservationMask so each payload shape stays explicit.
 */
export function createResponsesInputObservationMask(keepRecentTurns: number = 8) {
  return (items: ResponsesInputItem[]): ResponsesInputItem[] => {
    const boundary = findResponsesTurnBoundary(items, keepRecentTurns);
    if (boundary === 0) return items;

    return items.map((item, i) => {
      if (i >= boundary) return item;
      if (item.type === "function_call_output") {
        return { ...item, output: MASK_PLACEHOLDER };
      }
      if (isResponsesBashResultUserItem(item)) {
        return { ...item, content: RESPONSES_MASK_CONTENT_BLOCK };
      }
      return item;
    });
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

function truncateTextBlocks(content: unknown, maxChars: number): unknown {
  if (typeof content === "string") {
    return truncateText(content, maxChars);
  }
  if (!Array.isArray(content)) return content;

  let remaining = maxChars;
  let didTruncate = false;
  const nextBlocks: unknown[] = [];

  for (const block of content) {
    if (!isTextLikeBlock(block) || typeof block.text !== "string") {
      nextBlocks.push(block);
      continue;
    }

    if (remaining <= 0) {
      didTruncate = true;
      continue;
    }

    const text = block.text;
    if (text.length <= remaining) {
      nextBlocks.push(block);
      remaining -= text.length;
      continue;
    }

    nextBlocks.push({ ...block, text: truncateText(text, remaining) });
    remaining = 0;
    didTruncate = true;
  }

  return didTruncate ? nextBlocks : content;
}

function normalizedMaxChars(maxChars: number): number {
  return Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 800;
}

export function truncateContextResultMessages(messages: MaskableMessage[], maxChars: number = 800): MaskableMessage[] {
  const limit = normalizedMaxChars(maxChars);
  return messages.map((message) => {
    if (!isMaskableMessage(message)) return message;
    const content = truncateTextBlocks(message.content, limit);
    return content === message.content ? message : { ...message, content };
  });
}

export function truncateResponsesInputResultItems(items: ResponsesInputItem[], maxChars: number = 800): ResponsesInputItem[] {
  const limit = normalizedMaxChars(maxChars);
  return items.map((item) => {
    if (item.type === "function_call_output") {
      const output = truncateTextBlocks(item.output, limit);
      return output === item.output ? item : { ...item, output };
    }
    if (isResponsesBashResultUserItem(item)) {
      const content = truncateTextBlocks(item.content, limit);
      return content === item.content ? item : { ...item, content };
    }
    return item;
  });
}
