// Project/App: gsd-pi
// File Purpose: Tool execution registration and compact row rollup for interactive chat.
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";
import {
	type RenderedSegment,
	type StreamingRenderState,
	type ToolRegistrationSource,
} from "../streaming-render-state.js";
import {
	ToolExecutionComponent,
	ToolPhaseSummaryComponent,
	type ToolExecutionPhase,
} from "../components/tool-execution.js";
import { markFirstVisibleAssistantOutput } from "./chat-controller-latency.js";

function findPendingToolByInvocation(
	pendingTools: Map<string, ToolExecutionComponent>,
	streamState: StreamingRenderState,
	toolName: string,
	args: unknown,
	source: ToolRegistrationSource,
): ToolExecutionComponent | undefined {
	let fallback: ToolExecutionComponent | undefined;
	for (const component of pendingTools.values()) {
		if (!component.isInFlight()) continue;
		if (!component.matchesInvocation(toolName, args)) continue;

		const sources = streamState.toolRegistrationSources.get(component);
		if (!sources?.has(source)) {
			return component;
		}
		if (sources.size > 1 && !fallback) fallback = component;
	}
	return fallback;
}

export function registerPendingToolComponent(
	host: InteractiveModeStateHost,
	toolCallId: string,
	toolName: string,
	args: unknown,
	source: ToolRegistrationSource,
	createComponent: () => ToolExecutionComponent,
): { component: ToolExecutionComponent; created: boolean } {
	const streamState = host.streamingRenderState;
	const existing = host.pendingTools.get(toolCallId);
	if (existing) {
		return { component: existing, created: false };
	}

	const matched = findPendingToolByInvocation(host.pendingTools, streamState, toolName, args, source);
	if (matched) {
		host.pendingTools.set(toolCallId, matched);
		streamState.toolRegistrationSources.get(matched)?.add(source);
		return { component: matched, created: false };
	}

	const component = createComponent();
	component.setExpanded(host.toolOutputExpanded);
	host.chatContainer.addChild(component);
	markFirstVisibleAssistantOutput(host, "tool", { toolName, source });
	host.pendingTools.set(toolCallId, component);
	streamState.toolRegistrationSources.set(component, new Set([source]));
	return { component, created: true };
}

function mergeToolPhases(phases: ToolExecutionPhase[]): ToolExecutionPhase[] {
	const merged: ToolExecutionPhase[] = [];
	for (const phase of phases) {
		const previous = merged[merged.length - 1];
		if (previous?.label === phase.label) {
			previous.count += phase.count;
			previous.durationMs += phase.durationMs;
			previous.targets = mergeTargets(previous.targets, phase.targets);
			if (previous.actionLabel !== phase.actionLabel) {
				previous.actionLabel = undefined;
			}
		} else {
			merged.push({ ...phase, targets: phase.targets ? [...phase.targets] : undefined });
		}
	}
	return merged;
}

function mergeTargets(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
	if (!existing && !incoming) return undefined;
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const target of [...(existing ?? []), ...(incoming ?? [])]) {
		if (!target || seen.has(target)) continue;
		seen.add(target);
		merged.push(target);
	}
	return merged;
}

export function replaceCompactToolRowsWithPhaseSummary(
	host: InteractiveModeStateHost & { ui: { requestRender: () => void } },
): void {
	const streamState = host.streamingRenderState;
	let changed = false;
	const nextRenderedSegments: RenderedSegment[] = [];
	let rollupRun: Array<{
		seg: Extract<RenderedSegment, { kind: "tool" | "tool-summary" }>;
		phases: ToolExecutionPhase[];
	}> = [];

	const flushRollupRun = () => {
		const actionCount = rollupRun.reduce(
			(total, item) => total + item.phases.reduce((sum, phase) => sum + phase.count, 0),
			0,
		);
		if (actionCount < 2) {
			nextRenderedSegments.push(...rollupRun.map((item) => item.seg));
			rollupRun = [];
			return;
		}

		const firstIndex = Math.max(0, host.chatContainer.children.indexOf(rollupRun[0].seg.component));
		const phases = mergeToolPhases(rollupRun.flatMap((item) => item.phases));
		const summary = new ToolPhaseSummaryComponent(phases);

		for (const { seg } of rollupRun) {
			host.chatContainer.removeChild(seg.component);
		}

		host.chatContainer.addChild(summary);
		const summaryIndex = host.chatContainer.children.indexOf(summary);
		if (summaryIndex !== -1 && summaryIndex !== firstIndex) {
			host.chatContainer.children.splice(summaryIndex, 1);
			host.chatContainer.children.splice(firstIndex, 0, summary);
			(host.chatContainer as unknown as { _prevRender: string[] | null })._prevRender = null;
		}

		changed = true;
		nextRenderedSegments.push({ kind: "tool-summary", component: summary, phases });
		rollupRun = [];
	};

	for (const seg of streamState.renderedSegments) {
		const phase = seg.kind === "tool" ? seg.component.getRollupPhase() : null;
		if (seg.kind === "tool" && phase) {
			rollupRun.push({ seg, phases: [phase] });
			continue;
		}
		if (seg.kind === "tool-summary") {
			rollupRun.push({ seg, phases: seg.component.getPhases() });
			continue;
		}

		flushRollupRun();
		nextRenderedSegments.push(seg);
	}
	flushRollupRun();

	if (changed) {
		streamState.renderedSegments = nextRenderedSegments;
		host.ui.requestRender();
	}
}
