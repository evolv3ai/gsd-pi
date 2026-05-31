// gsd-pi + packages/pi-coding-agent/src/modes/interactive/components/extension-selector.ts - Extension option selector.
/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 * Options starting with SEPARATOR_PREFIX are rendered as non-selectable group headers.
 */

import { Container, getEditorKeybindings, matchesKey, Spacer, Text, type TUI } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { CountdownTimer } from "./countdown-timer.js";
import { DialogContainer, splitDialogTitle } from "./dialog-container.js";
import { selectorFooter } from "./keybinding-hints.js";

/** Prefix that marks an option as a non-selectable group header. */
export const SEPARATOR_PREFIX = "───";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
}

export class ExtensionSelectorComponent extends DialogContainer {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		const dialogTitle = splitDialogTitle(title);
		super(dialogTitle.title);

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.baseTitle = dialogTitle.title;

		this.addChild(new Spacer(1));
		for (const detail of dialogTitle.detailLines) {
			this.addChild(new Text(theme.fg("text", detail), 1, 0));
		}
		if (dialogTitle.detailLines.length > 0) {
			this.addChild(new Spacer(1));
		}

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.setDialogTitle(`${this.baseTitle} (${s}s)`),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				selectorFooter(),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Start on the first selectable (non-separator) item
		this.selectedIndex = this.nextSelectable(0, 1);
		this.updateList();
	}

	private isSeparator(index: number): boolean {
		return this.options[index]?.startsWith(SEPARATOR_PREFIX) ?? false;
	}

	/**
	 * Find the next selectable index starting from `from` in the given direction.
	 * Returns `from` clamped to bounds if nothing selectable is found.
	 */
	private nextSelectable(from: number, direction: 1 | -1): number {
		let idx = from;
		while (idx >= 0 && idx < this.options.length && this.isSeparator(idx)) {
			idx += direction;
		}
		if (idx < 0 || idx >= this.options.length) {
			return Math.max(0, Math.min(from, this.options.length - 1));
		}
		// If all items are separators, idx may still point to one — fall back to original index
		if (this.isSeparator(idx)) {
			return Math.max(0, Math.min(from, this.options.length - 1));
		}
		return idx;
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const option = this.options[i];
			if (this.isSeparator(i)) {
				this.listContainer.addChild(new Text(theme.fg("borderAccent", `  ${option}`), 1, 0));
				continue;
			}
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", option)
				: `  ${theme.fg("text", option)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectUp") || matchesKey(keyData, "k")) {
			let next = this.selectedIndex - 1;
			if (next < 0) next = this.options.length - 1;
			next = this.nextSelectable(next, -1);
			if (this.isSeparator(next)) {
				next = this.nextSelectable(this.options.length - 1, -1);
			}
			this.selectedIndex = next;
			this.updateList();
		} else if (kb.matches(keyData, "selectDown") || matchesKey(keyData, "j")) {
			let next = this.selectedIndex + 1;
			if (next >= this.options.length) next = 0;
			next = this.nextSelectable(next, 1);
			if (this.isSeparator(next)) {
				next = this.nextSelectable(0, 1);
			}
			this.selectedIndex = next;
			this.updateList();
		} else if (kb.matches(keyData, "selectConfirm")) {
			const selected = this.options[this.selectedIndex];
			if (selected && !this.isSeparator(this.selectedIndex)) {
				this.onSelectCallback(selected);
			}
		} else if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
