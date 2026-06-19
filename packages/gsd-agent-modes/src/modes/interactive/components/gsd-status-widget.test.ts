// Project/App: gsd-pi
// File Purpose: Tests for the collapsible GSD status widget.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";

import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { GsdStatusWidget } from "./gsd-status-widget.js";

initTheme("dark", false);

describe("GsdStatusWidget", () => {
	test("renders nothing when idle in auto chat mode", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 0,
			cwd: "/tmp/project",
			manuallyExpanded: false,
		}));
		assert.deepEqual(widget.render(100), []);
	});

	test("renders a single collapsed line during workflow", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 1,
			gsdPhase: "Executing T03 renderer polish",
			cwd: "/tmp/project",
			manuallyExpanded: false,
		}));
		const plain = widget.render(100).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /GSD AUTO/);
		assert.match(plain, /Executing T03/);
		assert.match(plain, /1 running/);
	});

	test("auto-expands on blocking error", () => {
		const widget = new GsdStatusWidget(() => ({
			override: "auto",
			activeToolCount: 0,
			lastError: "Recovery signal",
			cwd: "/tmp/project",
			manuallyExpanded: false,
		}));
		const plain = widget.render(100).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /Alert/);
		assert.match(plain, /Recovery signal/);
	});
});
