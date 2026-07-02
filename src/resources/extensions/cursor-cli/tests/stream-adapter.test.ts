import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context, Model } from "@gsd/pi-ai";
import {
	buildCursorAgentRunPlan,
	buildCursorPrompt,
	buildCursorSpawnInvocation,
	parseCursorAgentLine,
	streamViaCursorAgent,
} from "../stream-adapter.ts";

const model = {
	id: "composer-2.5",
	name: "Composer 2.5",
	api: "cursor-stream-json",
	provider: "cursor-agent",
	baseUrl: "local://cursor-agent",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
} as Model<string>;

const context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user", content: "Hello" }],
	tools: [{ name: "gsd_plan_slice" }],
} as Context;

test("buildCursorAgentRunPlan invokes cursor-agent in stream-json prompt mode", () => {
	const plan = buildCursorAgentRunPlan("composer-2.5", "Prompt", "/tmp/project", "linux");
	assert.equal(plan.command, "cursor-agent");
	assert.deepEqual(plan.args, ["-p", "Prompt", "--output-format", "stream-json", "--model", "composer-2.5", "--workspace", "/tmp/project", "--trust"]);
});

test("buildCursorSpawnInvocation uses cmd /c on Windows", () => {
	assert.deepEqual(buildCursorSpawnInvocation("cursor-agent", ["--version"], "win32"), {
		command: "cmd",
		args: ["/c", "cursor-agent", "--version"],
	});
});

test("buildCursorPrompt preserves system, message, and tool context", () => {
	const prompt = buildCursorPrompt(context);
	assert.match(prompt, /System instructions:\nBe concise\./);
	assert.match(prompt, /User:\nHello/);
	assert.match(prompt, /Requested GSD tools: gsd_plan_slice/);
});

test("parseCursorAgentLine maps text, legacy tool, result, usage, and errors", () => {
	assert.deepEqual(parseCursorAgentLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'), {
		type: "text",
		text: "hi",
	});
	assert.deepEqual(parseCursorAgentLine('{"type":"tool_call","id":"tool_1","name":"edit","input":{"path":"a"}}'), {
		type: "tool_call",
		toolCall: { type: "toolCall", id: "tool_1", name: "edit", arguments: { path: "a" } },
	});
	assert.deepEqual(parseCursorAgentLine('{"type":"tool_result","tool_call_id":"tool_1","content":"ok","is_error":false}'), {
		type: "tool_result",
		toolCallId: "tool_1",
		result: { content: [{ type: "text", text: "ok" }], isError: false },
	});
	assert.deepEqual(parseCursorAgentLine('{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}'), {
		type: "usage",
		usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
	});
	assert.deepEqual(parseCursorAgentLine('{"type":"error","message":"boom"}'), { type: "error", message: "boom" });
});

test("parseCursorAgentLine ignores Cursor-owned nested tool events so GSD does not redispatch them", () => {
	const started = parseCursorAgentLine(
		'{"type":"tool_call","subtype":"started","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}}}',
	);

	assert.deepEqual(started, { type: "ignore" });

	const completed = parseCursorAgentLine(
		'{"type":"tool_call","subtype":"completed","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}},"result":{"content":"ok"}}',
	);

	assert.deepEqual(completed, { type: "ignore" });
});

test("streamViaCursorAgent does not surface Cursor-owned nested tool events as local tool calls", async () => {
	const lines = [
		'{"type":"assistant","message":{"content":[{"type":"text","text":"I will inspect the file."}]}}',
		'{"type":"tool_call","subtype":"started","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}}}',
		'{"type":"tool_call","subtype":"completed","call_id":"tool_1","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}},"result":{"content":"ok"}}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}',
	];
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "", code: 0, signal: null }),
	});

	const events = [];
	for await (const event of stream) events.push(event);

	const done = events.find((event) => event.type === "done");
	assert.ok(done && done.type === "done");
	assert.ok(
		!done.message.content.some((block) => block.type === "toolCall"),
		"Cursor-owned internal tool events must not become local GSD tool calls",
	);
	assert.ok(!events.some((event) => event.type === "toolcall_start"));
});

test("streamViaCursorAgent emits complete stdout lines before cursor-agent exits", async () => {
	let releaseRunner: (() => void) | undefined;
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async (_plan, _options, onLine) => {
			onLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Live"}]}}');
			await new Promise<void>((resolve) => { releaseRunner = resolve; });
			return { stdout: "", stderr: "", code: 0, signal: null };
		},
	});

	const iterator = stream[Symbol.asyncIterator]();
	const firstDelta = (async () => {
		for (;;) {
			const next = await iterator.next();
			if (next.done) return undefined;
			if (next.value.type === "text_delta") return next.value;
		}
	})();

	const event = await Promise.race([
		firstDelta,
		new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
	]);
	assert.ok(event, "expected streamed text before runner completed");
	assert.equal(event.type, "text_delta");
	assert.equal(event.delta, "Live");

	releaseRunner?.();
	for (;;) {
		const next = await iterator.next();
		if (next.done) break;
	}
});

test("streamViaCursorAgent turns NDJSON into assistant events with external tool results", async () => {
	const lines = [
		'{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
		'{"type":"tool_call","id":"tool_1","name":"edit","input":{"path":"a"}}',
		'{"type":"tool_result","tool_call_id":"tool_1","content":"ok","is_error":false}',
		'{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}',
	];
	const stream = streamViaCursorAgent(model, context, {
		_cursorAgentRunnerForTest: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "", code: 0, signal: null }),
	});

	const events = [];
	for await (const event of stream) events.push(event);

	const done = events.find((event) => event.type === "done");
	assert.ok(done && done.type === "done");
	assert.equal(done.message.content[0].type, "text");
	assert.equal(done.message.content[0].text, "Hi");
	const toolCall = done.message.content.find((block) => block.type === "toolCall");
	assert.ok(toolCall && toolCall.type === "toolCall");
	assert.deepEqual(toolCall.externalResult, { content: [{ type: "text", text: "ok" }], isError: false });
	assert.equal(done.message.usage.input, 3);
	assert.equal(done.message.usage.output, 4);
});
