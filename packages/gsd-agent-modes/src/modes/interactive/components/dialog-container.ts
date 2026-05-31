import { Container, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";

function padVisible(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function renderTopBorder(title: string, width: number, border: (text: string) => string): string {
	const trimmedTitle = title.trim();
	if (!trimmedTitle || width < 10) {
		return border("╭" + "─".repeat(width - 2) + "╮");
	}

	const safeTitle = truncateToWidth(trimmedTitle, Math.max(0, width - 7), "");
	const fill = Math.max(0, width - visibleWidth(safeTitle) - 5);
	return border("╭─ ") + theme.bold(theme.fg("accent", safeTitle)) + border(" " + "─".repeat(fill) + "╮");
}

export class DialogContainer extends Container {
	private dialogTitle: string;

	constructor(title: string) {
		super();
		this.dialogTitle = title;
	}

	setDialogTitle(title: string): void {
		this.dialogTitle = title;
	}

	render(width: number): string[] {
		const outerWidth = Math.max(1, width);
		if (outerWidth < 4) return super.render(outerWidth).map((line) => truncateToWidth(line, outerWidth, ""));

		const contentWidth = Math.max(1, outerWidth - 4);
		const border = (text: string) => theme.fg("borderAccent", text);
		const lines = [renderTopBorder(this.dialogTitle, outerWidth, border)];

		for (const line of super.render(contentWidth)) {
			lines.push(border("│") + " " + padVisible(line, contentWidth) + " " + border("│"));
		}

		lines.push(border("╰" + "─".repeat(outerWidth - 2) + "╯"));
		return lines;
	}
}

export function splitDialogTitle(title: string): { title: string; detailLines: string[] } {
	const lines = title.split(/\r?\n/);
	return {
		title: lines[0] ?? "",
		detailLines: lines.slice(1).filter((line) => line.trim().length > 0),
	};
}
