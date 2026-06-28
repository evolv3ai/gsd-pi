import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@gsd/pi-tui";

import { handleAgentEvent } from "./controllers/chat-controller.js";
import { createStreamingRenderState } from "./streaming-render-state.js";

function makeMinimalHost(chatContainer: Container, streamingRenderState = createStreamingRenderState()) {
	return {
		isInitialized: true,
		streamingRenderState,
		footer: { invalidate() {} },
		settingsManager: {
			getTimestampFormat() {
				return "date-time-iso";
			},
			getShowImages() {
				return false;
			},
		},
		getMarkdownThemeWithSettings() {
			return undefined;
		},
		getRegisteredToolDefinition() {
			return undefined;
		},
		formatWebSearchResult() {
			return "";
		},
		session: { messages: [], retryAttempt: 0 },
		chatContainer,
		pendingTools: new Map(),
		pendingMessagesContainer: { clear() {} },
		pinnedMessageContainer: new Container(),
		statusContainer: new Container(),
		hideThinkingBlock: true,
		toolOutputExpanded: false,
		defaultWorkingMessage: "Working...",
		clearBlockingError() {},
		compactionQueuedMessages: [],
		ui: {
			terminal: { rows: 60, columns: 100 },
			requestRender() {},
		},
		init: async () => {},
		addMessageToChat() {},
		checkShutdownRequested: async () => {},
		rebuildChatFromMessages() {},
		flushCompactionQueue: async () => {},
		showStatus() {},
		showError() {},
		updatePendingMessagesDisplay() {},
		updateTerminalTitle() {},
		updateEditorBorderColor() {},
	};
}

test("StreamingRenderState: two InteractiveMode hosts do not share segment state", async () => {
	const stateA = createStreamingRenderState();
	const stateB = createStreamingRenderState();
	const hostA = makeMinimalHost(new Container(), stateA);
	const hostB = makeMinimalHost(new Container(), stateB);

	const assistantStart = {
		type: "message_start",
		message: { role: "assistant", content: [] },
	} as const;

	await handleAgentEvent(hostA as any, assistantStart as any);
	stateA.renderedSegments.push({
		kind: "text-run",
		startIndex: 0,
		endIndex: 0,
		contentType: "text",
		component: {} as any,
	});

	await handleAgentEvent(hostB as any, assistantStart as any);

	assert.equal(stateA.renderedSegments.length, 1);
	assert.equal(stateB.renderedSegments.length, 0);
	assert.equal(stateA.lastProcessedContentIndex, 0);
	assert.equal(stateB.lastProcessedContentIndex, 0);
});

test("golden: message_start assistant resets streaming state for new turn", async () => {
	const rs = createStreamingRenderState();
	rs.lastProcessedContentIndex = 5;
	rs.renderedSegments.push({
		kind: "text-run",
		startIndex: 0,
		endIndex: 0,
		contentType: "text",
		component: {} as any,
	});

	const host = makeMinimalHost(new Container(), rs);
	await handleAgentEvent(host as any, {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
	} as any);

	assert.equal(rs.renderedSegments.length, 0);
	assert.equal(rs.lastProcessedContentIndex, 0);
	assert.equal(rs.lastContentLength, 0);
});
