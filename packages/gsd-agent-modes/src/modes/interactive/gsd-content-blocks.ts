import type { ServerToolUse, WebSearchResult } from "@gsd/pi-ai";

export function getContentBlockType(block: unknown): string | undefined {
	if (typeof block !== "object" || block === null || !("type" in block)) {
		return undefined;
	}
	return String((block as { type: unknown }).type);
}

export function isToolContentBlock(block: unknown): boolean {
	const type = getContentBlockType(block);
	return type === "toolCall" || type === "serverToolUse";
}

export function asServerToolUse(block: unknown): ServerToolUse | undefined {
	return getContentBlockType(block) === "serverToolUse" ? (block as ServerToolUse) : undefined;
}

export function asWebSearchResult(block: unknown): WebSearchResult | undefined {
	return getContentBlockType(block) === "webSearchResult" ? (block as WebSearchResult) : undefined;
}
