// Project/App: gsd-pi
// File Purpose: Visual contract test for the user message plain surface (Variant A).

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

describe("UserMessageComponent plain surface", () => {
	test("renders corner opener, speaker line, and unboxed body", () => {
		const component = new UserMessageComponent(
			"Can we make the transcript feel like chat?",
			undefined,
			1,
			"date-time-iso",
		);
		const plain = component.render(100).map((line) => stripVTControlCharacters(line)).join("\n");

		assert.match(plain, /YOU/);
		assert.match(plain, /feel like chat/);
		assert.match(plain, /╭─ YOU/);
		assert.doesNotMatch(plain, /╯/);
		assert.doesNotMatch(plain, /[│┃]/);
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
});
