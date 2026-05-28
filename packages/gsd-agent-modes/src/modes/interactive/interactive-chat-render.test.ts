// Project/App: gsd-pi
// File Purpose: Regression tests for interactive chat transcript trimming.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage } from "@gsd/pi-ai";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { Container } from "@gsd/pi-tui";

import { AssistantMessageComponent } from "./components/assistant-message.js";
import { MAX_CHAT_COMPONENTS } from "./interactive-mode-class-constants.js";
import { addMessageToChat, renderSessionContext } from "./interactive-chat-render.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

initTheme("dark", false);

function createHost(): InteractiveModeDelegateHost {
	return {
		chatContainer: new Container(),
		pendingTools: new Map(),
		settingsManager: {
			getTimestampFormat: () => "date-time-iso",
			getShowImages: () => false,
		},
		getMarkdownThemeWithSettings: () => undefined,
		getRegisteredToolDefinition: () => undefined,
		formatWebSearchResult: () => "",
		session: { retryAttempt: 0 },
		editor: {},
		footer: { invalidate() {} },
		updateEditorBorderColor() {},
		ui: { requestRender() {} },
	} as unknown as InteractiveModeDelegateHost;
}

function userMessage(index: number): AgentMessage {
	return {
		id: `u-${index}`,
		role: "user",
		timestamp: index,
		content: [{ type: "text", text: `User ${index}` }],
	} as unknown as AgentMessage;
}

function assistantMessage(index: number): AgentMessage {
	return {
		id: `a-${index}`,
		role: "assistant",
		provider: "test",
		model: "test-model",
		timestamp: index,
		content: [{ type: "text", text: `Assistant ${index}` }],
	} as unknown as AgentMessage;
}

function assistantWithTool(index: number): AssistantMessage {
	return {
		id: `a-tool-${index}`,
		role: "assistant",
		provider: "test",
		model: "test-model",
		timestamp: index,
		content: [
			{ type: "text", text: `Assistant ${index}` },
			{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: { path: "README.md" } },
		],
	} as unknown as AssistantMessage;
}

function connectedToUser(component: AssistantMessageComponent): boolean {
	return (component as unknown as { connectedToUser: boolean }).connectedToUser;
}

describe("interactive chat trimming", () => {
	test("reconciles assistant connection flags after incremental trim removes the paired user turn", () => {
		const host = createHost();

		for (let i = 0; i <= MAX_CHAT_COMPONENTS; i++) {
			addMessageToChat(host, i % 2 === 0 ? userMessage(i) : assistantMessage(i));
		}

		const firstChild = host.chatContainer.children[0];
		assert.ok(firstChild instanceof AssistantMessageComponent);
		assert.equal(host.chatContainer.children.length, MAX_CHAT_COMPONENTS);
		assert.equal(connectedToUser(firstChild), false);
	});

	test("reconciles assistant connection flags after session replay trim removes the paired user turn", () => {
		const host = createHost();
		const messages: AgentMessage[] = [userMessage(0)];
		for (let i = 1; i <= MAX_CHAT_COMPONENTS / 2; i++) {
			messages.push(assistantWithTool(i) as unknown as AgentMessage);
		}

		renderSessionContext(host, { messages } as any);

		const firstChild = host.chatContainer.children[0];
		assert.ok(firstChild instanceof AssistantMessageComponent);
		assert.equal(host.chatContainer.children.length, MAX_CHAT_COMPONENTS);
		assert.equal(connectedToUser(firstChild), false);
	});
});
