import type { ImageContent } from "@gsd/pi-ai";

import { createStreamingRenderState, type StreamingRenderState } from "./streaming-render-state.js";

/** Loaders and working-message chrome for one interactive TUI instance. */
export interface InteractiveModeLoaderState {
	loadingAnimation?: { stop(): void; setMessage?(msg: string): void };
	activityLoader?: { stop(): void };
	pendingWorkingMessage?: string | null;
	defaultWorkingMessage: string;
	autoCompactionLoader?: unknown;
	autoCompactionEscapeHandler?: () => void;
	retryLoader?: { stop(): void };
	retryEscapeHandler?: () => void;
}

/** Streaming chat presentation state (segment walker + pinned zone). */
export interface InteractiveModeStreamingState {
	streamingComponent?: unknown;
	streamingMessage?: {
		role: string;
		content: unknown[];
		provider?: string;
		model?: string;
		stopReason?: string;
		errorMessage?: string;
	};
	pendingTools: Map<string, unknown>;
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	streamingRenderState: StreamingRenderState;
}

/** Extension UI widget maps and editor buffer. */
export interface InteractiveModeExtensionUiState {
	extensionSelector?: unknown;
	extensionInput?: unknown;
	extensionEditor?: unknown;
	pendingImages: ImageContent[];
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
}

export interface InteractiveModeUiState {
	loaders: InteractiveModeLoaderState;
	streaming: InteractiveModeStreamingState;
	extensionUi: InteractiveModeExtensionUiState;
}

export function createInteractiveModeUiState(defaultWorkingMessage = "Working..."): InteractiveModeUiState {
	return {
		loaders: {
			defaultWorkingMessage,
			pendingWorkingMessage: undefined,
		},
		streaming: {
			pendingTools: new Map(),
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			streamingRenderState: createStreamingRenderState(),
		},
		extensionUi: {
			pendingImages: [],
			compactionQueuedMessages: [],
		},
	};
}
