import type { ImageContent, TextContent, ToolResultMessage } from "./types.js";

function stringifyToolResultContent(content: unknown): string {
	try {
		const value = JSON.stringify(content);
		if (typeof value === "string") return value;
	} catch {
		// Fall through to String(content). JSON.stringify can throw for cycles.
	}

	try {
		return String(content);
	} catch {
		return "[unstringifiable tool result content]";
	}
}

/**
 * Normalise untrusted tool-result content into the transcript/provider shape.
 *
 * Tool implementations are typed to return content arrays, but external tools
 * and older transcripts may violate that contract. Keep the runtime boundary
 * defensive so downstream providers, hooks, renderers, and resume paths always
 * see an array of content blocks.
 */
function serializableCacheControl(candidate: Record<string, unknown>): Record<string, unknown> {
	if (!("cache_control" in candidate)) return {};
	try {
		JSON.stringify(candidate.cache_control);
		return { cache_control: candidate.cache_control };
	} catch {
		return {};
	}
}

function normalizeToolResultContentBlock(block: unknown): TextContent | ImageContent {
	if (typeof block === "string") return { type: "text", text: block } satisfies TextContent;
	if (block && typeof block === "object") {
		const candidate = block as Record<string, unknown>;
		const cacheControl = serializableCacheControl(candidate);
		if (candidate.type === "text" && typeof candidate.text === "string") {
			return { type: "text", text: candidate.text, ...cacheControl } as unknown as TextContent;
		}
		if (candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string") {
			return { type: "image", data: candidate.data, mimeType: candidate.mimeType, ...cacheControl } as unknown as ImageContent;
		}
	}
	return { type: "text", text: stringifyToolResultContent(block) } satisfies TextContent;
}

export function normalizeToolResultContent(content: unknown): ToolResultMessage["content"] {
	if (Array.isArray(content)) {
		const blocks = content.map((block) => normalizeToolResultContentBlock(block));
		return blocks.length > 0 ? blocks : [{ type: "text", text: "" } satisfies TextContent];
	}
	if (typeof content === "string") return [{ type: "text", text: content } satisfies TextContent];
	if (content == null) return [{ type: "text", text: "" } satisfies TextContent];
	return [{ type: "text", text: stringifyToolResultContent(content) } satisfies TextContent];
}
