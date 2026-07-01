import type { AgentSessionEvent } from "@gsd/agent-core";
import {
	appendToolSegment,
	applyTextDelta,
	applyThinkingDelta,
	completeTurn,
	finalizeThinkingStream,
	pushPendingUserMessage,
	resetActiveTurn,
	type TranscriptChatMessage,
	type TranscriptState,
} from "@gsd/agent-core";

type ActiveToolExecution = {
	id: string;
	name: string;
	args: Record<string, unknown>;
};

type TranscriptStateWithActiveTool = TranscriptState & {
	activeToolExecution?: ActiveToolExecution | null;
};

function asTranscriptUserMessage(message: { role?: string; content?: unknown }): TranscriptChatMessage | null {
	if (message.role !== "user") return null;
	return { role: "user", content: message.content };
}

/** Pure reducer: apply one AgentSessionEvent to transcript state (TUI + web parity). */
export function applyAgentEventToTranscript(state: TranscriptState, event: AgentSessionEvent): TranscriptState {
	switch (event.type) {
		case "message_start": {
			if (event.message.role === "user") {
				const user = asTranscriptUserMessage(event.message);
				return user ? pushPendingUserMessage(resetActiveTurn(state), user) : state;
			}
			if (event.message.role === "assistant") {
				return resetActiveTurn(state);
			}
			return state;
		}
		case "message_update": {
			if (event.message.role !== "assistant") return state;
			const inner = event.assistantMessageEvent;
			if (inner.type === "text_delta" && typeof inner.delta === "string") {
				return applyTextDelta(state, inner.delta);
			}
			if (inner.type === "thinking_delta" && typeof inner.delta === "string") {
				return applyThinkingDelta(state, inner.delta);
			}
			if (inner.type === "thinking_end") {
				return finalizeThinkingStream(state);
			}
			return state;
		}
		case "message_end": {
			if (event.message.role === "user") return state;
			if (event.message.role === "assistant") {
				return completeTurn(state);
			}
			return state;
		}
		case "tool_execution_start": {
			return {
				...state,
				streamingAssistantText: "",
				streamingThinkingText: "",
				activeToolExecution: {
					id: event.toolCallId,
					name: event.toolName,
					args: (event.args as Record<string, unknown> | undefined) ?? {},
				},
			} as TranscriptState;
		}
		case "tool_execution_end": {
			const active = (state as TranscriptStateWithActiveTool).activeToolExecution;
			const args = active?.id === event.toolCallId ? active.args : {};
			const next = appendToolSegment(state, {
				id: event.toolCallId,
				name: event.toolName,
				args,
				result: {
					content: event.result.content as Array<{ type: string; text?: string }> | undefined,
					details: event.result.details as Record<string, unknown> | undefined,
					isError: event.isError,
				},
			});
			return { ...next, activeToolExecution: null } as TranscriptState;
		}
		case "agent_end":
		case "turn_end":
			return completeTurn(state);
		default:
			return state;
	}
}
