// Project/App: gsd-pi
// File Purpose: Regression tests for widgetMode density in GsdStatusWidget.

import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { GsdStatusWidget } from "../../packages/gsd-agent-modes/src/modes/interactive/components/gsd-status-widget.ts";
import { initTheme } from "../../packages/pi-coding-agent/src/theme/theme.ts";

initTheme("dark", false);

const WIDTH = 160;

function makeProgress(widgetMode: "min" | "small" | "full") {
	return {
		phase: "Executing T01",
		modeTag: "AUTO" as const,
		taskProgress: { done: 3, total: 10 },
		sliceLabel: "S01",
		taskLabel: "T01",
		unitLabel: "execute-task",
		elapsed: "0:42",
		healthSummary: "some health info",
		path: "/tmp/gsd-pi",
		widgetMode,
	};
}

test("GsdStatusWidget widgetMode=min renders one line (header only)", () => {
	const widget = new GsdStatusWidget(() => ({
		override: "auto",
		activeToolCount: 1,
		cwd: "/tmp/gsd-pi",
		manuallyExpanded: undefined,
		gsdProgress: makeProgress("min"),
	}));
	const lines = widget.render(WIDTH).map((line) => stripVTControlCharacters(line));
	assert.equal(lines.length, 1, "min mode should produce exactly 1 line");
	assert.match(lines[0], /GSD AUTO/);
});

test("GsdStatusWidget widgetMode=small renders header with task progress on the right, no workflow line", () => {
	const widget = new GsdStatusWidget(() => ({
		override: "auto",
		activeToolCount: 1,
		cwd: "/tmp/gsd-pi",
		manuallyExpanded: undefined,
		gsdProgress: makeProgress("small"),
	}));
	const lines = widget.render(WIDTH).map((line) => stripVTControlCharacters(line));
	assert.equal(lines.length, 1, "small mode should keep slice/task progress on the header line");
	assert.match(lines[0], /GSD AUTO/);
	assert.match(lines[0], /tasks .* 3\/10/);
	assert.match(lines[0], /●/);
	assert.doesNotMatch(lines[0], /█/);
	assert.ok(lines[0].trimEnd().endsWith("execute-task"), "task progress should sit on the far right");
	assert.doesNotMatch(lines.join("\n"), /ctrl\+shift\+d/);
});

test("GsdStatusWidget widgetMode=full renders header + health summary + workflow line", () => {
	const widget = new GsdStatusWidget(() => ({
		override: "auto",
		activeToolCount: 1,
		cwd: "/tmp/gsd-pi",
		manuallyExpanded: undefined,
		gsdProgress: makeProgress("full"),
	}));
	const lines = widget.render(WIDTH).map((line) => stripVTControlCharacters(line));
	assert.equal(lines.length, 3, "full mode should render header, health summary, and workflow line");
	assert.match(lines[0], /GSD AUTO/);
	assert.match(lines[0], /tasks .* 3\/10/);
	const fullText = lines.join("\n");
	assert.match(fullText, /ctrl\+shift\+d/);
});

test("GsdStatusWidget manuallyExpanded=false collapses regardless of widgetMode=full", () => {
	const widget = new GsdStatusWidget(() => ({
		override: "auto",
		activeToolCount: 0,
		cwd: "/tmp/gsd-pi",
		manuallyExpanded: false,
		gsdProgress: makeProgress("full"),
	}));
	const lines = widget.render(WIDTH).map((line) => stripVTControlCharacters(line));
	assert.equal(lines.length, 1, "manuallyExpanded=false should collapse to 1 line");
});

test("GsdStatusWidget manuallyExpanded=true expands regardless of widgetMode=min", () => {
	const widget = new GsdStatusWidget(() => ({
		override: "auto",
		activeToolCount: 0,
		cwd: "/tmp/gsd-pi",
		manuallyExpanded: true,
		gsdProgress: makeProgress("min"),
	}));
	const lines = widget.render(WIDTH).map((line) => stripVTControlCharacters(line));
	assert.ok(lines.length > 1, "manuallyExpanded=true should expand beyond 1 line");
});
