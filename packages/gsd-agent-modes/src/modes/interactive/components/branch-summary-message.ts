// gsd-pi + packages/pi-coding-agent/src/modes/interactive/components/branch-summary-message.ts - Branch summary message renderer.

import { Markdown, type MarkdownTheme, Text } from "@gsd/pi-tui";
import type { BranchSummaryMessage } from "@gsd/pi-coding-agent/core/messages.js";
import { getMarkdownTheme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { CollapsibleMessageComponent } from "./collapsible-message.js";
import { renderChatFrame } from "./transcript-design.js";
import { editorKey } from "./keybinding-hints.js";

/**
 * Renders a branch summary as a plain system line (◇ branch header,
 * copy-clean body) matching compaction and skill notices.
 */
export class BranchSummaryMessageComponent extends CollapsibleMessageComponent {
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.rebuildContent();
	}

	protected rebuildContent(): void {
		this.clear();

		if (this.expanded) {
			const header = "**Branch Summary**\n\n";
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("customMessageText", "Branch summary (") +
						theme.fg("dim", editorKey("expandTools")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}

	override render(width: number): string[] {
		const cached = this.getCachedRender(width);
		if (cached) return cached;

		const frameWidth = Math.max(20, width);
		const lines = super.render(frameWidth);
		const framed = renderChatFrame(lines, frameWidth, {
			label: "branch",
			tone: "skill",
			timestampFormat: "date-time-iso",
			showTimestamp: false,
		});
		return this.setCachedRender(width, framed.length > 0 ? ["", ...framed] : framed);
	}
}
