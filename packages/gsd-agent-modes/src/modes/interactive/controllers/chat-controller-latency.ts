// Project/App: gsd-pi
// File Purpose: TUI turn latency markers for interactive chat streaming.
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";

export function markTuiLatency(
	host: InteractiveModeStateHost,
	phase: string,
	data?: Record<string, unknown>,
): void {
	host.session?.markTurnLatency?.(phase, data);
}

export function markFirstVisibleAssistantOutput(
	host: InteractiveModeStateHost,
	kind: "text" | "thinking" | "tool" | "message_end_only",
	data?: Record<string, unknown>,
): void {
	host.session?.markFirstVisibleTurnLatency?.(kind, data);
}
