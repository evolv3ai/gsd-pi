import assert from "node:assert/strict";
import test from "node:test";

import { createInitialTranscriptState } from "@gsd/agent-core";

import { applyAgentEventToTranscript } from "./tui-transcript-tracker.js";

test("applyAgentEventToTranscript: message_start user queues pending message", () => {
	let state = createInitialTranscriptState();
	state = applyAgentEventToTranscript(state, {
		type: "message_start",
		message: { role: "user", content: "hi" },
	} as any);
	assert.equal(state.pendingUserMessage?.role, "user");
});

test("applyAgentEventToTranscript: tool invocation args survive start -> end (web parity)", () => {
	let state = createInitialTranscriptState();
	state = applyAgentEventToTranscript(state, {
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "read",
		args: { path: "a.ts" },
	} as any);
	state = applyAgentEventToTranscript(state, {
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "read",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	} as any);
	const toolSeg = state.currentTurnSegments.find((s) => s.kind === "tool");
	assert.ok(toolSeg && toolSeg.kind === "tool");
	if (toolSeg.kind === "tool") {
		assert.deepEqual(toolSeg.tool.args, { path: "a.ts" });
	}
});

test("applyAgentEventToTranscript: thinking_end finalizes the thinking stream into a segment", () => {
	let state = createInitialTranscriptState();
	state = applyAgentEventToTranscript(state, {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_delta", delta: "pondering" },
	} as any);
	assert.equal(state.streamingThinkingText, "pondering");
	state = applyAgentEventToTranscript(state, {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_end" },
	} as any);
	assert.equal(state.streamingThinkingText, "");
	const thinkingSeg = state.currentTurnSegments.find((s) => s.kind === "thinking");
	assert.ok(thinkingSeg && thinkingSeg.kind === "thinking");
	if (thinkingSeg.kind === "thinking") {
		assert.equal(thinkingSeg.content, "pondering");
	}
});

test("applyAgentEventToTranscript: tool_execution_start drops provisional pre-tool streaming text", () => {
	let state = createInitialTranscriptState();
	state = applyAgentEventToTranscript(state, {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "provisional pre-tool prose" },
	} as any);
	assert.equal(state.streamingAssistantText, "provisional pre-tool prose");
	state = applyAgentEventToTranscript(state, {
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "read",
		args: {},
	} as any);
	assert.equal(state.streamingAssistantText, "");
	assert.equal(state.streamingThinkingText, "");
});

test("applyAgentEventToTranscript: agent_end completes the active turn", () => {
	let state = createInitialTranscriptState();
	state = applyAgentEventToTranscript(state, {
		type: "message_start",
		message: { role: "user", content: "hi" },
	} as any);
	state = applyAgentEventToTranscript(state, {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "answer" },
	} as any);
	state = applyAgentEventToTranscript(state, { type: "agent_end", messages: [], willRetry: false } as any);
	assert.equal(state.completedTurns.length, 1);
	assert.equal(state.pendingUserMessage, null);
	assert.equal(state.streamingAssistantText, "");
	assert.equal(state.completedTurns[0]?.userMessage?.content, "hi");
	const textSeg = state.completedTurns[0]?.segments.find((s) => s.kind === "text");
	assert.ok(textSeg && textSeg.kind === "text");
	if (textSeg.kind === "text") {
		assert.equal(textSeg.content, "answer");
	}
});

test("applyAgentEventToTranscript: turn_end completes the active turn", () => {
	let state = createInitialTranscriptState();
	state = applyAgentEventToTranscript(state, {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "answer" },
	} as any);
	state = applyAgentEventToTranscript(state, { type: "turn_end", message: { role: "assistant" }, toolResults: [] } as any);
	assert.equal(state.completedTurns.length, 1);
	assert.equal(state.streamingAssistantText, "");
});
