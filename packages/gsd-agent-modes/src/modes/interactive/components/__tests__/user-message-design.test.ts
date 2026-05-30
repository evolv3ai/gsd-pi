// Project/App: gsd-pi
// File Purpose: Visual contract test for the user message open surface.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { UserMessageComponent } from "../user-message.js";

initTheme("dark", false);

const OSC133_ZONE = /\x1b]133;[AB]\x07/;
const ENV_KEYS = ["TERM_PROGRAM", "GSD_ENABLE_OSC133_ZONES", "GSD_DISABLE_OSC133_ZONES"] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, run: () => void): void {
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
		(typeof ENV_KEYS)[number],
		string | undefined
	>;
	try {
		for (const key of ENV_KEYS) {
			const value = values[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		run();
	} finally {
		for (const key of ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

describe("UserMessageComponent connected rail", () => {
	test("renders a user message like GSD with a transparent connected card", () => {
		const component = new UserMessageComponent(
			"Can we make the transcript feel like chat?",
			undefined,
			1,
			"date-time-iso",
		);
		const raw = component.render(100);
		const plain = raw.map((line) => stripVTControlCharacters(line)).join("\n").split("\n");

		const joined = plain.join("\n");
		assert.match(joined, /YOU/);
		assert.match(joined, /feel like chat/);
		assert.match(joined, /╭─ YOU/);
		assert.match(joined, /╰/);
		assert.doesNotMatch(joined, /[│┃]/, "user content lines must not use side rail glyphs");
		const topRuleIndex = plain.findIndex((line) => line.includes("YOU") && line.includes("─"));
		const contentIndex = plain.findIndex((line) => line.includes("feel like chat"));
		assert.ok(contentIndex > topRuleIndex, `expected content after the top rule:\n${joined}`);
		assert.doesNotMatch(raw[contentIndex] ?? "", /\x1b\[48[;:]/, "user content rows should not paint a background");
		assert.ok(plain[topRuleIndex]?.startsWith("    ╭─ YOU"), `user turn should indent for the connected bridge:\n${joined}`);
		assert.ok(plain[contentIndex]?.startsWith("       "), `user content should keep inner padding:\n${joined}`);
		assert.equal(plain[contentIndex]?.length, 100, `user content row should fill the card interior:\n${joined}`);
		assert.match(plain[contentIndex] ?? "", /^    /, `user content should remain aligned with the rail gutter:\n${joined}`);
		assert.doesNotMatch(plain[contentIndex] ?? "", /[│┃╭╮╰╯]/, `content line must stay copy-clean:\n${joined}`);
	});

	test("opens the bottom when the next assistant turn will bridge", () => {
		const component = new UserMessageComponent("follow-up");
		component.setContinuesToAssistant(true);
		const plain = component
			.render(80)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");

		assert.match(plain, /╭─ YOU/);
		assert.doesNotMatch(plain, /╰─{4,}/, `connected user turns should omit the closing rule:\n${plain}`);
	});

	test("keeps connected-state renders in separate cache entries", () => {
		const component = new UserMessageComponent("follow-up");
		const closed = component.render(80).map((line) => stripVTControlCharacters(line)).join("\n");
		(component as unknown as { continuesToAssistant: boolean }).continuesToAssistant = true;
		const open = component.render(80).map((line) => stripVTControlCharacters(line)).join("\n");

		assert.match(closed, /╰─{4,}/);
		assert.doesNotMatch(open, /╰─{4,}/, `connected user turns should not reuse a closed cached render:\n${open}`);
	});

	test("starts flush at the card top rule", () => {
		const component = new UserMessageComponent("hello");
		const plain = component.render(80).map((line) => stripVTControlCharacters(line));

		assert.ok(plain[0]?.includes("╭─ YOU"), `user turn should start on the card top rule:\n${plain.join("\n")}`);
	});

	test("does not inject OSC 133 zones for unsupported terminals", () => {
		withEnv(
			{
				TERM_PROGRAM: "Apple_Terminal",
				GSD_ENABLE_OSC133_ZONES: undefined,
				GSD_DISABLE_OSC133_ZONES: undefined,
			},
			() => {
				const component = new UserMessageComponent("Plain terminal output");
				const joined = component.render(100).join("\n");

				assert.doesNotMatch(joined, OSC133_ZONE);
			},
		);
	});

	test("can emit OSC 133 zones when explicitly enabled", () => {
		withEnv(
			{
				TERM_PROGRAM: "Apple_Terminal",
				GSD_ENABLE_OSC133_ZONES: "1",
				GSD_DISABLE_OSC133_ZONES: undefined,
			},
			() => {
				const component = new UserMessageComponent("Shell integration zone");
				const joined = component.render(100).join("\n");

				assert.match(joined, OSC133_ZONE);
			},
		);
	});

	test("reuses rendered output until terminal integration state changes", () => {
		const component = new UserMessageComponent("Cached user output");
		let first: string[] | undefined;

		withEnv(
			{
				TERM_PROGRAM: "Apple_Terminal",
				GSD_ENABLE_OSC133_ZONES: undefined,
				GSD_DISABLE_OSC133_ZONES: undefined,
			},
			() => {
				first = component.render(100);
				assert.equal(component.render(100), first);
				assert.doesNotMatch(first.join("\n"), OSC133_ZONE);
			},
		);

		withEnv(
			{
				TERM_PROGRAM: "Apple_Terminal",
				GSD_ENABLE_OSC133_ZONES: "1",
				GSD_DISABLE_OSC133_ZONES: undefined,
			},
			() => {
				const withOsc = component.render(100);

				assert.notEqual(withOsc, first);
				assert.match(withOsc.join("\n"), OSC133_ZONE);
			},
		);
	});
});
