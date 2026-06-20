// Project/App: gsd-pi
// File Purpose: Left-edge user message renderer for interactive chat transcripts (corner-framed dialog).

import { Container, Markdown, type MarkdownTheme } from "@gsd/pi-tui";
import { getMarkdownTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { RenderCache } from "./render-cache.js";
import { formatTimestamp, type TimestampFormat } from "./timestamp.js";
import { renderPlainSpeakerMessage } from "./transcript-design.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";

function shouldEmitOsc133Zones(): boolean {
	if (process.env.GSD_DISABLE_OSC133_ZONES === "1") return false;
	if (process.env.GSD_ENABLE_OSC133_ZONES === "1") return true;
	return process.env.TERM_PROGRAM === "iTerm.app";
}

/**
 * Component that renders a user message as a plain speaker line + unboxed body.
 */
export class UserMessageComponent extends Container {
	private timestamp: number | undefined;
	private timestampFormat: TimestampFormat;
	private renderCache = new RenderCache();
	private renderVersion = 0;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), timestamp?: number, timestampFormat: TimestampFormat = "date-time-iso") {
		super();
		this.timestamp = timestamp;
		this.timestampFormat = timestampFormat;
		this.addChild(new Markdown(text, 0, 0, markdownTheme));
	}

	override invalidate(): void {
		super.invalidate();
		this.clearRenderCache();
	}

	/** @deprecated Plain transcript has no connected rails. */
	setContinuesToAssistant(_value: boolean): void {}

	override render(width: number): string[] {
		const emitOsc133Zones = shouldEmitOsc133Zones();
		const cacheKey = `${width}:${this.renderVersion}:${emitOsc133Zones ? 1 : 0}`;
		const cached = this.renderCache.get(cacheKey);
		if (cached) return cached;

		const frameWidth = Math.max(20, width);
		const lines = super.render(frameWidth);
		const meta =
			this.timestamp !== undefined
				? formatTimestamp(this.timestamp, this.timestampFormat)
				: undefined;
		const framed = renderPlainSpeakerMessage(lines, frameWidth, {
			label: "YOU",
			meta,
			tone: "user",
			trailingBlank: false,
		});
		if (framed.length === 0) {
			return framed;
		}
		if (!emitOsc133Zones) {
			return this.renderCache.set(cacheKey, framed);
		}
		const out = [...framed];
		const firstFrameLine = 0;
		// Skip trailing blank lines so the end-of-command marker lands on the
		// last content line, not on the spacer appended by renderPlainSpeakerMessage.
		let lastFrameLine = out.length - 1;
		while (lastFrameLine > firstFrameLine && out[lastFrameLine] === "") {
			lastFrameLine--;
		}
		out[firstFrameLine] = OSC133_ZONE_START + out[firstFrameLine];
		out[lastFrameLine] = out[lastFrameLine] + OSC133_ZONE_END;
		return this.renderCache.set(cacheKey, out);
	}

	private clearRenderCache(): void {
		this.renderVersion++;
		this.renderCache.clear();
	}
}
