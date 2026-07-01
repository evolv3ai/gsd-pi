import type { ExtensionWidgetOptions } from "@gsd/pi-coding-agent/core/extensions/index.js";

/** Extension UI chrome captured for RPC replay and web bridge sync. */
export interface ExtensionUiSnapshot {
	statusByKey: Record<string, string | undefined>;
	widgetsByKey: Record<string, { content: unknown; options?: ExtensionWidgetOptions }>;
	workingMessage: string | null | undefined;
	title: string | undefined;
	editorText: string | undefined;
	hasCustomHeader: boolean;
	hasCustomFooter: boolean;
}

export function createEmptyExtensionUiSnapshot(): ExtensionUiSnapshot {
	return {
		statusByKey: {},
		widgetsByKey: {},
		workingMessage: undefined,
		title: undefined,
		editorText: undefined,
		hasCustomHeader: false,
		hasCustomFooter: false,
	};
}

/** Web workspace fields that mirror extension UI chrome. */
export interface WebExtensionUiFields {
	statusTexts: Record<string, string>;
	widgetContents: Record<string, { lines: string[] | undefined; placement?: string }>;
	titleOverride: string | null;
	editorTextBuffer: string | null;
	workingMessage?: string | null;
}

export function extensionUiSnapshotFromWebFields(fields: WebExtensionUiFields): ExtensionUiSnapshot {
	const widgetsByKey: ExtensionUiSnapshot["widgetsByKey"] = {};
	for (const [key, widget] of Object.entries(fields.widgetContents)) {
		widgetsByKey[key] = {
			content: widget.lines,
			options: widget.placement ? { placement: widget.placement as ExtensionWidgetOptions["placement"] } : undefined,
		};
	}
	return {
		statusByKey: { ...fields.statusTexts },
		widgetsByKey,
		workingMessage: fields.workingMessage,
		title: fields.titleOverride ?? undefined,
		editorText: fields.editorTextBuffer ?? undefined,
		hasCustomHeader: false,
		hasCustomFooter: false,
	};
}

export function applyExtensionUiSnapshotToWebFields(
	fields: WebExtensionUiFields,
	snapshot: ExtensionUiSnapshot,
): WebExtensionUiFields {
	const widgetContents: WebExtensionUiFields["widgetContents"] = {};
	for (const [key, widget] of Object.entries(snapshot.widgetsByKey)) {
		const lines = Array.isArray(widget.content)
			? (widget.content as string[])
			: typeof widget.content === "string"
				? [widget.content]
				: undefined;
		widgetContents[key] = {
			lines,
			placement: widget.options?.placement,
		};
	}
	return {
		statusTexts: { ...snapshot.statusByKey } as Record<string, string>,
		widgetContents,
		titleOverride: snapshot.title?.trim() ? snapshot.title : null,
		editorTextBuffer: snapshot.editorText ?? null,
		workingMessage: snapshot.workingMessage,
	};
}

export function extensionUiSnapshotFromRpcMaps(input: {
	statusState: Map<string, string | undefined>;
	widgetState: Map<string, { content: unknown; options?: ExtensionWidgetOptions }>;
	workingMessageState: string | null | undefined;
	titleState: string | undefined;
	editorTextState: string | undefined;
	hasCustomHeader: boolean;
	hasCustomFooter: boolean;
}): ExtensionUiSnapshot {
	return {
		statusByKey: Object.fromEntries(input.statusState.entries()),
		widgetsByKey: Object.fromEntries(input.widgetState.entries()),
		workingMessage: input.workingMessageState,
		title: input.titleState,
		editorText: input.editorTextState,
		hasCustomHeader: input.hasCustomHeader,
		hasCustomFooter: input.hasCustomFooter,
	};
}
