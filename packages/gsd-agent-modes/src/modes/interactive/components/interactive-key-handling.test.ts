// gsd-pi + packages/pi-coding-agent/src/modes/interactive/components/interactive-key-handling.test.ts - Interactive component key handling regressions.

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	EditorKeybindingsManager,
	setEditorKeybindings,
	setKittyProtocolActive,
	TUI,
	visibleWidth,
	type EditorTheme,
	type Terminal,
} from "@gsd/pi-tui";
import { KeybindingsManager } from "@gsd/agent-core";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { CustomEditor } from "./custom-editor.js";
import { ExtensionEditorComponent } from "./extension-editor.js";
import { ExtensionInputComponent } from "./extension-input.js";
import { ExtensionSelectorComponent } from "./extension-selector.js";

function makeTerminal(): Terminal {
	return {
		isTTY: true,
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
	};
}

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};

function assertFullOuterBorder(lines: string[], width: number): void {
	assert.ok(lines.length >= 2, "dialog must include top and bottom borders");
	for (const [index, line] of lines.entries()) {
		assert.equal(visibleWidth(line), width, `line ${index} must fill dialog width`);
	}
	const top = stripVTControlCharacters(lines[0] ?? "");
	const bottom = stripVTControlCharacters(lines.at(-1) ?? "");
	assert.match(top, /^[╭┌].*[╮┐]$/);
	assert.match(bottom, /^[╰└].*[╯┘]$/);
	for (let index = 1; index < lines.length - 1; index++) {
		const line = stripVTControlCharacters(lines[index] ?? "");
		assert.match(line, /^[│┃├]/, `line ${index} missing left border: ${line}`);
		assert.match(line, /[│┃┤]$/, `line ${index} missing right border: ${line}`);
	}
}

describe("interactive component key handling", () => {
	beforeEach(() => {
		initTheme("dark", false);
		setEditorKeybindings(new EditorKeybindingsManager());
		setKittyProtocolActive(false);
	});

	afterEach(() => {
		setEditorKeybindings(new EditorKeybindingsManager());
		setKittyProtocolActive(false);
	});

	it("extension input follows a remapped confirm key instead of raw newline", () => {
		setEditorKeybindings(new EditorKeybindingsManager({ selectConfirm: "ctrl+s" }));
		let submitted: string | undefined;
		const input = new ExtensionInputComponent("Title", undefined, (value) => {
			submitted = value;
		}, () => {});

		input.handleInput("o");
		input.handleInput("k");
		input.handleInput("\n");

		assert.equal(submitted, undefined);

		input.handleInput("\x13");

		assert.equal(submitted, "ok");
	});

	it("extension selector follows a remapped confirm key instead of raw newline", () => {
		setEditorKeybindings(new EditorKeybindingsManager({ selectConfirm: "ctrl+s" }));
		let selected: string | undefined;
		const selector = new ExtensionSelectorComponent("Pick", ["alpha", "beta"], (option) => {
			selected = option;
		}, () => {});

		selector.handleInput("\n");

		assert.equal(selected, undefined);

		selector.handleInput("\x13");

		assert.equal(selected, "alpha");
	});

	it("extension selector keeps vi-style navigation through semantic key matching", () => {
		let selected: string | undefined;
		const selector = new ExtensionSelectorComponent("Pick", ["alpha", "beta", "gamma"], (option) => {
			selected = option;
		}, () => {});

		selector.handleInput("j");
		selector.handleInput("j");
		selector.handleInput("k");
		selector.handleInput("\r");

		assert.equal(selected, "beta");
	});

	it("extension selector, input, and editor render full dialog borders", () => {
		const width = 80;
		const tui = new TUI(makeTerminal());
		const components = [
			new ExtensionSelectorComponent("Pick\nChoose one", ["alpha", "beta"], () => {}, () => {}),
			new ExtensionInputComponent("Input\nType a value", "placeholder", () => {}, () => {}),
			new ExtensionEditorComponent(tui, KeybindingsManager.inMemory(), "Editor\nWrite details", "", () => {}, () => {}),
		];

		for (const component of components) {
			assertFullOuterBorder(component.render(width), width);
		}
	});

	it("custom editor treats the legacy alt-enter sequence as newline outside kitty mode", () => {
		const editor = new CustomEditor(new TUI(makeTerminal()), editorTheme, KeybindingsManager.inMemory());
		let followUp = false;
		editor.onAction("followUp", () => {
			followUp = true;
		});

		editor.handleInput("\x1b\r");

		assert.equal(followUp, false);
		assert.equal(editor.getText(), "\n");
	});
});
