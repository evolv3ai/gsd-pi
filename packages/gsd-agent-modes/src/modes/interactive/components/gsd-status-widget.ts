// Project/App: gsd-pi
// File Purpose: Collapsible GSD auto-mode status widget above the editor (Grok-style minimal chrome).

import { alignRight, type Component, padRight, truncateToWidth } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { AdaptiveLayoutState } from "./adaptive-layout.js";
import type { GsdProgressState } from "./gsd-progress-state.js";
import { resolveTuiMode } from "../tui-mode.js";
import { badge, layoutFullWidthFooter, layoutMinimalFooter, renderProgressBar } from "./transcript-design.js";

export interface GsdStatusWidgetState extends AdaptiveLayoutState {
	manuallyExpanded: boolean;
	gsdProgress?: GsdProgressState;
}

function padLine(line: string, width: number): string {
	return padRight(truncateToWidth(line, width, "…"), width);
}

function basename(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	if (!trimmed) return cwd.includes("\\") ? "\\" : "/";
	const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function isWidgetActive(state: GsdStatusWidgetState, width: number): boolean {
	if (state.gsdProgress) return true;
	if (state.lastError) return true;
	if ((state.activeToolCount ?? 0) > 0) return true;
	if (state.gsdPhase) return true;
	if (state.override !== "auto" && state.override !== "chat") return true;
	const mode = resolveTuiMode({
		terminalWidth: width,
		override: state.override,
		gsdPhase: state.gsdPhase,
		activeToolCount: state.activeToolCount,
		hasBlockingError: !!state.lastError,
	});
	return mode !== "chat";
}

export function isGsdStatusWidgetVisible(state: GsdStatusWidgetState, width: number): boolean {
	return isWidgetActive(state, width);
}

function renderProgressDrivenStrip(state: GsdStatusWidgetState, width: number): string[] {
	const progress = state.gsdProgress!;
	const autoExpand = !!state.lastError;
	const expanded = state.manuallyExpanded || autoExpand;

	const phase = progress.phase || state.gsdPhase || "Ready";
	const modeTag =
		progress.modeTag === "NEXT" ? theme.fg("success", progress.modeTag) : undefined;
	const headLeft = [
		badge("● GSD AUTO", "accent"),
		modeTag,
		theme.fg("text", truncateToWidth(phase, Math.max(12, width - 36), "…")),
	]
		.filter(Boolean)
		.join(" ");
	const headRightParts = [progress.elapsed, progress.eta].filter(Boolean);
	const headRight = headRightParts.length > 0 ? theme.fg("dim", headRightParts.join(" · ")) : "";
	const headLine = padLine(alignRight(headLeft, headRight, width), width);

	if (!expanded) {
		return [headLine];
	}

	const lines = [headLine];

	if (progress.healthSummary) {
		lines.push(padLine(theme.fg("dim", truncateToWidth(progress.healthSummary, width, "…")), width));
	}

	const taskProgress = progress.taskProgress;
	if (taskProgress && taskProgress.total > 0) {
		const taskSegments = [
			theme.fg("accent", `${taskProgress.done}/${taskProgress.total} tasks`),
			progress.sliceLabel ? theme.fg("dim", progress.sliceLabel) : undefined,
			progress.taskLabel ? theme.fg("dim", progress.taskLabel) : undefined,
			progress.unitLabel ? theme.fg("text", progress.unitLabel) : undefined,
		].filter((segment): segment is string => !!segment);
		const taskLine = layoutFullWidthFooter(taskSegments, width, 0, (budget) =>
			renderProgressBar(taskProgress.done, taskProgress.total, Math.max(8, budget), "accent"),
		);
		lines.push(padLine(taskLine, width));
	}

	const toolCount = state.activeToolCount ?? 0;
	const workflowSegments = [
		theme.fg("dim", "tools ") +
			theme.fg(toolCount > 0 ? "toolRunning" : "text", toolCount > 0 ? `${toolCount} running` : "idle"),
		theme.fg("dim", "path ") + theme.fg("text", truncateToWidth(progress.path ?? basename(state.cwd), width - 20, "…")),
		theme.fg("dim", "ctrl+shift+d collapse"),
	];
	lines.push(padLine(workflowSegments.join(theme.fg("dim", " │ ")), width));

	return lines;
}

export class GsdStatusWidget implements Component {
	constructor(private readonly getState: () => GsdStatusWidgetState) {}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		if (!isWidgetActive(state, width)) {
			return [];
		}

		if (state.gsdProgress) {
			return renderProgressDrivenStrip(state, width);
		}

		const autoExpand = !!state.lastError;
		const expanded = state.manuallyExpanded || autoExpand;
		const phase = state.gsdPhase ?? (state.lastError ? "Recovery" : "Ready");
		const tools =
			(state.activeToolCount ?? 0) > 0 ? `${state.activeToolCount} running` : "idle";

		if (!expanded) {
			const phaseText = theme.fg("text", truncateToWidth(phase, Math.max(12, width - 28), "…"));
			const toolsText = theme.fg("dim", tools);
			const line = layoutMinimalFooter(
				[badge("● GSD AUTO", "accent"), phaseText, toolsText],
				width,
			);
			return [padLine(line, width)];
		}

		const headLeft = `${badge("● GSD AUTO", "accent")} ${theme.fg("accent", truncateToWidth(phase, Math.max(12, width - 20), "…"))}`;
		const headRight = state.lastError
			? theme.fg("warning", "recovery")
			: theme.fg("dim", tools);

		const toolCount = state.activeToolCount ?? 0;
		const progressSegments = [
			theme.fg("accent", toolCount > 0 ? `${toolCount} running` : "idle"),
			state.lastError
				? theme.fg("error", truncateToWidth(state.lastError, Math.max(20, width - 24), "…"))
				: theme.fg("dim", "path ") + theme.fg("text", basename(state.cwd)),
			theme.fg("dim", "ctrl+shift+d collapse"),
		];
		const progressLine = layoutFullWidthFooter(progressSegments, width, 0, (budget) =>
			renderProgressBar(
				toolCount > 0 ? Math.min(toolCount, 14) : 0,
				14,
				Math.max(10, budget),
				toolCount > 0 ? "running" : "muted",
			),
		);

		const hint = state.lastError
			? theme.fg("dim", "inspect failed output before retrying")
			: theme.fg("dim", "watch live output below");

		return [
			padLine(alignRight(headLeft, headRight, width), width),
			padLine(progressLine, width),
			padLine(hint, width),
		];
	}
}

export function gsdStatusCollapsedLine(state: GsdStatusWidgetState, width: number): string | undefined {
	if (!isWidgetActive(state, width)) return undefined;
	const phase = state.gsdProgress?.phase ?? state.gsdPhase ?? "Ready";
	return truncateToWidth(`● GSD AUTO · ${phase}`, Math.max(12, width), "…");
}
