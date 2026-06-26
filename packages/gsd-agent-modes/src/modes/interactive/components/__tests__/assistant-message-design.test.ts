// Project/App: gsd-pi
// File Purpose: Visual contract tests for the assistant message plain surface (Variant A).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import type { AssistantMessage } from "@gsd/pi-ai";

import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { AssistantMessageComponent } from "../assistant-message.js";
import { formatTimestamp } from "../timestamp.js";
import { renderPlainSpeakerMessage } from "../transcript-design.js";

initTheme("dark", false);

describe("AssistantMessageComponent plain surface", () => {
	test("renders assistant content with corner opener and unboxed body", () => {
		const message = {
			id: "m1",
			role: "assistant",
			provider: "test",
			model: "gpt-test",
			timestamp: 1,
			content: [{ type: "text", text: "I will update the renderer and run verification." }],
		} as unknown as AssistantMessage;

		const component = new AssistantMessageComponent(message, true);
		const plain = component.render(80).map((line) => stripAnsi(line));
		const joined = plain.join("\n");

		assert.match(joined, /GSD/);
		assert.match(joined, /gpt-test/);
		assert.match(joined, /update the renderer/);
		assert.match(joined, /╭─ GSD/);
		assert.doesNotMatch(joined, /╯/);
		assert.doesNotMatch(joined, /[│┃]/);
	});

	test("renderPlainSpeakerMessage matches component layout", () => {
		const plain = renderPlainSpeakerMessage(["Hey there"], 80, {
			label: "GSD",
			meta: "gpt-test",
			tone: "assistant",
		})
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(plain, /GSD/);
		assert.match(plain, /Hey there/);
		assert.match(plain, /╭─ GSD/);
		assert.doesNotMatch(plain, /╯/);
	});

	test("renders metadata for a zero timestamp", () => {
		const message = {
			id: "m1",
			role: "assistant",
			provider: "test",
			model: "gpt-test",
			timestamp: 0,
			content: [{ type: "text", text: "ok" }],
		} as unknown as AssistantMessage;

		const component = new AssistantMessageComponent(message, true);
		component.setShowMetadata(true);
		const plain = component.render(80).map((line) => stripAnsi(line)).join("\n");
		// Compute the expected local-timezone date for the Unix epoch using the same
		// local-time arithmetic as isoDate() so the assertion passes regardless of
		// the machine's timezone (UTC shows 1970-01-01, UTC-1 shows 1969-12-31, etc.).
		const d = new Date(0);
		const expectedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		assert.match(plain, new RegExp(expectedDate));
	});
});
