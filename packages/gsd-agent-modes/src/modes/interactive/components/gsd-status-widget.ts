// Project/App: gsd-pi
// File Purpose: Collapsible GSD auto-mode status widget above the editor (Grok-style minimal chrome).

import { type Component, truncateToWidth } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { AdaptiveLayoutState } from "./adaptive-layout.js";
import { resolveTuiMode } from "../tui-mode.js";
import { badge, keyValue, renderProgressBar, roundedPanel } from "./transcript-design.js";

export interface GsdStatusWidgetState extends AdaptiveLayoutState {
	manuallyExpanded: boolean;
}

function basename(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	if (!trimmed) return cwd.includes("\\") ? "\\" : "/";
	const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function isWidgetActive(state: GsdStatusWidgetState, width: number): boolean {
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

export class GsdStatusWidget implements Component {
	constructor(private readonly getState: () => GsdStatusWidgetState) {}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		if (!isWidgetActive(state, width)) {
			return [];
		}

		const autoExpand = !!state.lastError;
		const expanded = state.manuallyExpanded || autoExpand;
		const phase = state.gsdPhase ?? (state.lastError ? "Recovery" : "Ready");
		const tools =
			(state.activeToolCount ?? 0) > 0 ? `${state.activeToolCount} running` : "idle";

		if (!expanded) {
			const prefix = badge("● GSD AUTO", "accent");
			const phaseText = theme.fg("text", truncateToWidth(phase, Math.max(12, width - 28), "…"));
			const suffix = theme.fg("dim", ` · ${tools}`);
			const line = truncateToWidth(`${prefix} ${phaseText}${suffix}`, Math.max(20, width - 2), "…");
			return roundedPanel([line], width, { tone: "accent" });
		}

		const progress =
			(state.activeToolCount ?? 0) > 0
				? renderProgressBar(Math.min(state.activeToolCount ?? 0, 14), 14, 14, "running")
				: renderProgressBar(0, 14, 14, "muted");

		const rows = [
			`${badge("● GSD AUTO", "accent")} ${theme.fg("accent", truncateToWidth(phase, width - 16, "…"))}`,
			keyValue("Progress", progress, "surfaceAccent"),
			keyValue("Tools", tools, (state.activeToolCount ?? 0) > 0 ? "toolRunning" : "toolMuted"),
			state.lastError
				? keyValue("Alert", truncateToWidth(state.lastError, Math.max(20, width - 20), "…"), "error")
				: keyValue("Path", basename(state.cwd), "text"),
		];

		const hint = state.lastError
			? theme.fg("dim", "ctrl+shift+d collapse · inspect output")
			: theme.fg("dim", "ctrl+shift+d collapse");

		return [
			...roundedPanel(rows, width, {
				tone: state.lastError ? "warning" : "accent",
				rightTitle: state.lastError ? "recovery" : "auto",
			}),
			truncateToWidth(hint, width, "…"),
		];
	}
}

export function gsdStatusCollapsedLine(state: GsdStatusWidgetState, width: number): string | undefined {
	if (!isWidgetActive(state, width)) return undefined;
	const phase = state.gsdPhase ?? "Ready";
	return truncateToWidth(`● GSD AUTO · ${phase}`, Math.max(12, width), "…");
}
