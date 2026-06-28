import type { Markdown } from "@gsd/pi-tui";

import type { AssistantMessageComponent } from "./components/assistant-message.js";
import type { DynamicBorder } from "./components/dynamic-border.js";
import {
	ToolExecutionComponent,
	ToolPhaseSummaryComponent,
	type ToolExecutionPhase,
} from "./components/tool-execution.js";

/** Per streaming assistant turn — text runs, tools, and rollup summaries. */
export type RenderedSegment =
	| {
			kind: "text-run";
			startIndex: number;
			endIndex: number;
			contentType: "text" | "thinking";
			component: AssistantMessageComponent;
			/** Snapshot for redundant sub-turn detection after content[] shrinks. */
			cachedText?: string;
	  }
	| { kind: "tool"; contentIndex: number; component: ToolExecutionComponent }
	| { kind: "tool-summary"; component: ToolPhaseSummaryComponent; phases: ToolExecutionPhase[] };

export type DesiredSegment =
	| { kind: "text-run"; startIndex: number; endIndex: number; contentType: "text" | "thinking" }
	| { kind: "tool"; contentIndex: number; toolId: string };

export type ToolRegistrationSource = "content" | "standalone";

/**
 * Per InteractiveMode instance: streaming transcript walker + pinned message zone.
 * Replaces module-level globals in chat-controller.ts.
 */
export class StreamingRenderState {
	lastProcessedContentIndex = 0;
	lastContentLength = 0;
	renderedSegments: RenderedSegment[] = [];
	/** Displaced segments when provider sub-turn shrinks content[] mid-lifecycle. */
	orphanedSegments: RenderedSegment[] = [];
	readonly toolRegistrationSources = new WeakMap<ToolExecutionComponent, Set<ToolRegistrationSource>>();

	lastPinnedText = "";
	hasToolsInTurn = false;
	pinnedBorder: DynamicBorder | undefined;
	pinnedTextComponent: Markdown | undefined;
	pinnedZoneNeedsViewportRealign = false;

	resetStreamingSegments(): void {
		this.lastProcessedContentIndex = 0;
		this.lastContentLength = 0;
		this.renderedSegments = [];
		this.orphanedSegments = [];
	}

	resetPinnedZone(): void {
		if (this.pinnedBorder) {
			this.pinnedBorder.stopSpinner();
		}
		this.pinnedBorder = undefined;
		this.pinnedTextComponent = undefined;
		this.lastPinnedText = "";
		this.hasToolsInTurn = false;
		this.pinnedZoneNeedsViewportRealign = false;
	}

	resetForNewAssistantMessage(): void {
		this.resetStreamingSegments();
		this.resetPinnedZone();
	}

	resetForSessionChange(): void {
		this.resetForNewAssistantMessage();
	}
}

export function createStreamingRenderState(): StreamingRenderState {
	return new StreamingRenderState();
}
