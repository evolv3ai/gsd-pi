import { type Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";

type ThemeColor = Parameters<Theme["fg"]>[0];

export interface SharedDialogFrameOptions {
	borderColor?: ThemeColor;
	footer?: string | string[];
	paddingX?: number;
}

function safeLine(text: string, width: number): string {
	return truncateToWidth(text, width, "");
}

function padVisible(text: string, width: number): string {
	const clipped = safeLine(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function renderTopBorder(
	theme: Theme,
	title: string,
	width: number,
	border: (text: string) => string,
): string {
	const trimmedTitle = title.trim();
	if (!trimmedTitle || width < 10) {
		return border("╭" + "─".repeat(width - 2) + "╮");
	}

	const safeTitle = safeLine(trimmedTitle, Math.max(0, width - 7));
	const fill = Math.max(0, width - visibleWidth(safeTitle) - 5);
	return border("╭─ ") + theme.bold(theme.fg("accent", safeTitle)) + border(" " + "─".repeat(fill) + "╮");
}

export function renderSharedDialogFrame(
	theme: Theme,
	title: string,
	inner: string[],
	width: number,
	options: SharedDialogFrameOptions = {},
): string[] {
	if (width < 4) return inner.map((line) => safeLine(line, width));

	const paddingX = Math.max(0, options.paddingX ?? 1);
	const contentWidth = Math.max(0, width - 2 - paddingX * 2);
	const border = (text: string) => theme.fg(options.borderColor ?? "borderAccent", text);
	const pad = " ".repeat(paddingX);
	const lines = [renderTopBorder(theme, title, width, border)];

	for (const line of inner) {
		lines.push(border("│") + pad + padVisible(line, contentWidth) + pad + border("│"));
	}

	const footer = Array.isArray(options.footer)
		? options.footer
		: options.footer
			? [options.footer]
			: [];
	if (footer.length > 0) {
		lines.push(border("├" + "─".repeat(width - 2) + "┤"));
		for (const line of footer) {
			lines.push(border("│") + pad + padVisible(line, contentWidth) + pad + border("│"));
		}
	}

	lines.push(border("╰" + "─".repeat(width - 2) + "╯"));
	return lines;
}

