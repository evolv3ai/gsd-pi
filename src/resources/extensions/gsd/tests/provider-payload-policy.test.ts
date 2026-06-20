import test from "node:test";
import assert from "node:assert/strict";

import type { ContextManagementConfig } from "../preferences-types.js";
import type { ProviderPayloadPolicyDeps } from "../provider-payload-policy.js";

import { applyProviderPayloadPolicy } from "../provider-payload-policy.js";

function createDeps(
  overrides: Partial<ProviderPayloadPolicyDeps> & {
    context?: ContextManagementConfig | undefined;
    autoActive?: boolean;
    sourceContextBlock?: string | null;
  } = {},
): ProviderPayloadPolicyDeps {
  return {
    isAutoActive: () => overrides.autoActive ?? false,
    loadContextManagementConfig: () => overrides.context,
    renderSourceContextBlock: () => overrides.sourceContextBlock ?? null,
    getEffectiveServiceTier: () => undefined,
    supportsServiceTier: () => false,
    ...overrides,
  };
}

function textFromMessage(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = content.find((block): block is { text: string } => {
    return Boolean(block && typeof block === "object" && "text" in block && typeof block.text === "string");
  });
  return text?.text ?? "";
}

test("provider payload policy truncates tool results outside auto-mode without masking", () => {
  const messageText = "m".repeat(50);
  const responsesOutput = "r".repeat(50);
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: "keep me" }] },
      { role: "toolResult", content: [{ type: "text", text: messageText }] },
    ],
    input: [
      { role: "user", content: [{ type: "input_text", text: "keep me" }] },
      { type: "function_call_output", call_id: "call_test", output: responsesOutput },
    ],
  };

  applyProviderPayloadPolicy({
    payload,
    deps: createDeps({ context: { observation_mask_turns: 1, tool_result_max_chars: 10 } }),
  });

  const truncatedMessage = textFromMessage(payload.messages[1]);
  const truncatedResponsesOutput = String(payload.input[1]?.output ?? "");
  assert.match(truncatedMessage, /\[truncated\]/);
  assert.match(truncatedResponsesOutput, /\[truncated\]/);
  assert.doesNotMatch(truncatedMessage, /result masked/);
  assert.doesNotMatch(truncatedResponsesOutput, /result masked/);
});

test("provider payload policy appends source context after masking and truncation", () => {
  const sourceContextBlock = "## Source Context Block\n\n" + "full source text ".repeat(20);
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: "old turn" }] },
      { role: "toolResult", content: [{ type: "text", text: "old result ".repeat(20) }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "new turn" }] },
      { role: "toolResult", content: [{ type: "text", text: "new result ".repeat(20) }] },
    ],
  };

  applyProviderPayloadPolicy({
    payload,
    deps: createDeps({
      autoActive: true,
      context: { observation_mask_turns: 1, tool_result_max_chars: 80 },
      sourceContextBlock,
    }),
  });

  const oldResult = textFromMessage(payload.messages[1]);
  const newResult = textFromMessage(payload.messages[4]);
  const appendedContext = textFromMessage(payload.messages[payload.messages.length - 1]);

  assert.match(oldResult, /result masked/);
  assert.match(newResult, /\[truncated\]/);
  assert.equal(appendedContext, sourceContextBlock);
  assert.doesNotMatch(appendedContext, /\[truncated\]/);
});

test("provider payload policy applies ordering to Responses input payloads", () => {
  const sourceContextBlock = "## Source Context Block\n\n" + "responses source text ".repeat(20);
  const payload = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "old turn" }] },
      { type: "function_call_output", call_id: "call_old", output: "old result ".repeat(20) },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { role: "user", content: [{ type: "input_text", text: "new turn" }] },
      { type: "function_call_output", call_id: "call_new", output: "new result ".repeat(20) },
    ],
  };

  applyProviderPayloadPolicy({
    payload,
    deps: createDeps({
      autoActive: true,
      context: { observation_mask_turns: 1, tool_result_max_chars: 80 },
      sourceContextBlock,
    }),
  });

  assert.match(String(payload.input[1]?.output ?? ""), /result masked/);
  assert.match(String(payload.input[4]?.output ?? ""), /\[truncated\]/);
  assert.equal(textFromMessage(payload.input[payload.input.length - 1]), sourceContextBlock);
});

test("provider payload policy replaces existing source context blocks", () => {
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: "keep me" }] },
      { role: "user", content: [{ type: "text", text: "## Source Context Block\n\nstale" }] },
    ],
  };

  applyProviderPayloadPolicy({
    payload,
    deps: createDeps({
      autoActive: true,
      sourceContextBlock: "## Source Context Block\n\nfresh",
    }),
  });

  const sourceMessages = payload.messages.filter((message) => {
    return textFromMessage(message).startsWith("## Source Context Block");
  });
  assert.equal(sourceMessages.length, 1);
  assert.equal(textFromMessage(sourceMessages[0]), "## Source Context Block\n\nfresh");
});

test("provider payload policy sets service tier only for supported models", () => {
  const unsupported = {};
  applyProviderPayloadPolicy({
    payload: unsupported,
    modelId: "claude-opus-4-6",
    deps: createDeps({
      getEffectiveServiceTier: () => "priority",
      supportsServiceTier: (modelId) => modelId === "gpt-5.4",
    }),
  });
  assert.equal("service_tier" in unsupported, false);

  const supported: Record<string, unknown> = {};
  applyProviderPayloadPolicy({
    payload: supported,
    modelId: "gpt-5.4",
    deps: createDeps({
      getEffectiveServiceTier: () => "priority",
      supportsServiceTier: (modelId) => modelId === "gpt-5.4",
    }),
  });
  assert.equal(supported.service_tier, "priority");
});
