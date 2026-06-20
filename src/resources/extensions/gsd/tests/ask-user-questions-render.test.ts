/**
 * Regression tests for ask_user_questions renderResult when Claude Code MCP
 * omits structuredContent and the chat controller passes details as undefined
 * or an empty object.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import askUserQuestionsExtension from "../../ask-user-questions.ts";

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function getAskUserQuestionsTool() {
	const tools: any[] = [];
	askUserQuestionsExtension({ registerTool: (tool: any) => tools.push(tool) } as any);
	const tool = tools.find((t) => t.name === "ask_user_questions");
	assert.ok(tool, "ask_user_questions should be registered");
	return tool;
}

function renderText(tool: any, result: unknown, args?: unknown): string {
	const rendered = tool.renderResult(result, {}, fakeTheme, { args });
	return String((rendered as any).content ?? (rendered as any).text ?? rendered);
}

const depthQuestion = {
	id: "depth_check",
	header: "Depth Check",
	question: "Did I capture the depth right?",
	options: [
		{ label: "Yes, you got it", description: "Proceed" },
		{ label: "Not quite - let me clarify", description: "Clarify" },
	],
};

test("ask_user_questions renderResult shows answers when details is undefined (MCP text-only wire)", () => {
	const tool = getAskUserQuestionsTool();
	const contentText = JSON.stringify({
		answers: { depth_check: { answers: ["Yes, you got it"] } },
	});
	const text = renderText(
		tool,
		{
			content: [{ type: "text", text: contentText }],
			details: undefined,
			isError: false,
		},
		{ questions: [depthQuestion] },
	);

	assert.match(text, /✓/);
	assert.match(text, /Depth Check/);
	assert.match(text, /Yes, you got it/);
	assert.doesNotMatch(text, /Cancelled/i);
});

test("ask_user_questions renderResult shows answers when details is empty object (#cc-elicitation)", () => {
	const tool = getAskUserQuestionsTool();
	const contentText = JSON.stringify({
		answers: { depth_check: { answers: ["Yes, you got it"] } },
	});
	const text = renderText(
		tool,
		{
			content: [{ type: "text", text: contentText }],
			details: {},
			isError: false,
		},
		{ questions: [depthQuestion] },
	);

	assert.match(text, /Yes, you got it/);
	assert.doesNotMatch(text, /Cancelled/i);
});

test("ask_user_questions renderResult still shows Cancelled for explicit cancel payload", () => {
	const tool = getAskUserQuestionsTool();
	const text = renderText(
		tool,
		{
			content: [{ type: "text", text: "ask_user_questions was cancelled before receiving a response" }],
			details: { questions: [depthQuestion], response: null, cancelled: true },
			isError: false,
		},
		{ questions: [depthQuestion] },
	);

	assert.match(text, /Cancelled/i);
});
