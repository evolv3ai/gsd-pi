// Project/App: gsd-pi
// File Purpose: Interactive terminal footer renderer for workspace, model, usage, context, and extension status.

import { type Component, truncateToWidth } from "@gsd/pi-tui";
import type { AgentSession } from "@gsd/agent-core";
import type { ReadonlyFooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { providerAuthBadge, providerDisplayName } from "./model-selector.js";
import { badge, renderFooterStrip } from "./transcript-design.js";
import type { GsdStatusWidgetState } from "./gsd-status-widget.js";
import { gsdStatusCollapsedLine } from "./gsd-status-widget.js";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts (similar to web-ui)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Format a cost value for compact display.
 * Uses fewer decimal places for larger amounts.
 * @internal Exported for testing only.
 */
export function formatPromptCost(cost: number): string {
	if (cost < 0.001) return `$${cost.toFixed(4)}`;
	if (cost < 0.01) return `$${cost.toFixed(3)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
		private readonly getGsdStatus?: () => GsdStatusWidgetState,
	) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;
		const gsdState = this.getGsdStatus?.();

		const usageTotals = this.session.sessionManager.getUsageTotals();
		const totalInput = usageTotals.input;
		const totalOutput = usageTotals.output;
		const totalCacheRead = usageTotals.cacheRead;
		const totalCacheWrite = usageTotals.cacheWrite;
		const totalCost = usageTotals.cost;

		const displayModel = state.activeInferenceModel ?? state.model;

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? displayModel?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(0) : "?";

		const branch = this.footerData.getGitBranch();
		const branchSegment = branch ? theme.fg("dim", branch) : undefined;

		const modelName = displayModel?.id || "no-model";
		let modelSegment = theme.fg("text", modelName);
		if (displayModel?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			modelSegment =
				thinkingLevel === "off"
					? theme.fg("text", `${modelName} · thinking off`)
					: theme.fg("text", `${modelName} · ${thinkingLevel}`);
		}

		const inputSide = totalInput + totalCacheRead + totalCacheWrite;
		let cacheSegment: string | undefined;
		if (totalCacheRead > 0 && inputSide > 0) {
			const cachedPct = Math.round((totalCacheRead / inputSide) * 100);
			cacheSegment = theme.fg("success", `${cachedPct}%hit`);
		}

		let costSegment: string | undefined;
		const usingSubscription = displayModel ? this.session.modelRegistry.isUsingOAuth(displayModel) : false;
		if (totalCost || usingSubscription) {
			costSegment = theme.fg("warning", `$${totalCost.toFixed(2)}${usingSubscription ? " (sub)" : ""}`);
		}

		const gsdActive = gsdState && gsdStatusCollapsedLine(gsdState, width) !== undefined;
		const gsdSegment = gsdActive
			? badge("● GSD AUTO", "accent")
			: badge("● GSD", "default");

		const leftSegments = [gsdSegment, branchSegment, modelSegment, cacheSegment ?? costSegment].filter(
			(segment): segment is string => !!segment,
		).slice(0, 4);

		const barColor: "error" | "warning" | "success" =
			contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "success";
		const pctText = contextPercent === "?" ? "?" : `${contextPercent}%`;
		const colorizedPct =
			contextPercentValue > 90
				? theme.fg("error", pctText)
				: contextPercentValue > 70
					? theme.fg("warning", pctText)
					: theme.fg("text", pctText);
		const contextHint = `ctx ${colorizedPct}/${formatTokens(contextWindow)}`;

		const extensionStatuses = this.footerData.getExtensionStatuses();
		const extStatusText =
			extensionStatuses.size > 0
				? Array.from(extensionStatuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
						.join(" ")
				: "";

		let providerSuffix = "";
		if (this.footerData.getAvailableProviderCount() > 1 && displayModel) {
			const authMode = this.session.modelRegistry.getProviderAuthMode(displayModel.provider);
			const authLabel = providerAuthBadge(authMode);
			const providerLabel = providerDisplayName(displayModel.provider);
			providerSuffix = authLabel ? ` · ${providerLabel} · ${authLabel}` : ` · ${providerLabel}`;
		}

		const footerRight = truncateToWidth(
			`${contextHint}${providerSuffix}${extStatusText ? ` · ${extStatusText}` : ""} · ctrl+shift+d`,
			Math.max(20, Math.floor(width * 0.45)),
			"…",
		);

		return renderFooterStrip(leftSegments, footerRight, width);
	}
}
