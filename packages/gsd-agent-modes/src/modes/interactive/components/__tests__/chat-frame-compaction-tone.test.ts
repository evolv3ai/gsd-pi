// gsd-pi TUI Tests - System transcript visual contract coverage.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import {
	renderChatFrame,
	renderCompactToolStrip,
	renderPlainSpeakerMessage,
	TRANSCRIPT_SYSTEM_MARKER,
	TRANSCRIPT_TOOL_MARKER,
} from "../transcript-design.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

initTheme("dark", false);

// System notices use a plain ◇ header + copy-clean body (no horizontal rules).
// Chat dialog uses unmarked You/GSD headers; tools use ▸ prefix.

describe("transcript role separation", () => {
	test("chat dialog has no role marker on the header", () => {
		const lines = renderPlainSpeakerMessage(["Hello"], 60, {
			label: "YOU",
			meta: "12:00",
			tone: "user",
			trailingBlank: false,
		});
		const plain = stripAnsi(lines[0] ?? "");
		assert.ok(plain.includes("YOU"));
		assert.ok(!plain.includes(TRANSCRIPT_TOOL_MARKER));
		assert.ok(!plain.includes(TRANSCRIPT_SYSTEM_MARKER));
	});

	test("tool strip uses ▸ marker and uppercase tool name", () => {
		const lines = renderCompactToolStrip("read", "src/foo.ts", 80, {
			status: "success · 12ms",
			tone: "success",
		});
		const plain = stripAnsi(lines[0] ?? "");
		assert.ok(plain.includes(TRANSCRIPT_TOOL_MARKER));
		assert.ok(plain.includes("READ"));
		assert.ok(plain.includes("src/foo.ts"));
	});

	test("system frame uses ◇ marker with copy-clean body", () => {
		const lines = renderChatFrame(
			["Compacted from 1,224,262 tokens (ctrl+o to expand)"],
			60,
			{
				label: "compaction",
				tone: "compaction",
				timestampFormat: "date-time-iso",
				showTimestamp: false,
			},
		);

		assert.ok(lines.length >= 2, `expected header + body, got ${lines.length}`);
		const plain = lines.map((line) => stripAnsi(line));

		assert.ok(plain[0].includes(TRANSCRIPT_SYSTEM_MARKER), `header should include system marker: ${plain[0]}`);
		assert.ok(plain[0].includes("compaction"));
		assert.ok(!plain[0].includes("───"), "system header must not use horizontal rules");

		for (const body of plain.slice(1)) {
			assert.ok(!body.startsWith("│"), `body line must not start with │: ${JSON.stringify(body)}`);
			assert.ok(!body.startsWith("┃"), `body line must not start with ┃: ${JSON.stringify(body)}`);
		}
		assert.ok(
			plain.slice(1).some((body) => body.includes("Compacted from 1,224,262 tokens")),
			"a body line should include the original content",
		);
	});

	test("does not render a timestamp when showTimestamp is false", () => {
		const lines = renderChatFrame(["body"], 60, {
			label: "compaction",
			tone: "compaction",
			timestamp: Date.now(),
			timestampFormat: "date-time-iso",
			showTimestamp: false,
		});

		const joined = lines.map((line) => stripAnsi(line)).join("\n");
		assert.ok(!/\b20\d{2}\b/.test(joined), `timestamp should be suppressed when showTimestamp=false`);
	});

	test("system tone differs from assistant chat tone", () => {
		const assistant = renderPlainSpeakerMessage(["body"], 60, {
			label: "GSD",
			tone: "assistant",
			trailingBlank: false,
		}).join("\n");

		const system = renderChatFrame(["body"], 60, {
			label: "compaction",
			tone: "compaction",
			timestampFormat: "date-time-iso",
			showTimestamp: false,
		}).join("\n");

		assert.notEqual(assistant, system, "system and assistant headers must use different styling");
	});
});
