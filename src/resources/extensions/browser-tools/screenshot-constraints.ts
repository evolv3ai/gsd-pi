import type { Page } from "playwright";

// sharp is an optional native dependency. Load it lazily so that screenshot
// emitters still work on platforms where sharp is unavailable (e.g. bunx on
// Raspberry Pi). constrainScreenshot falls back to returning the raw buffer
// when sharp is not installed.
let _sharp: typeof import("sharp") | null | undefined;
async function getSharp(): Promise<typeof import("sharp") | null> {
	if (_sharp !== undefined) return _sharp;
	try {
		_sharp = (await import("sharp")).default;
	} catch {
		_sharp = null;
	}
	return _sharp;
}

/**
 * Test-only seam: override the cached sharp module. Pass `null` to simulate
 * an environment where the sharp native dep is unavailable; pass `undefined`
 * to clear the cache and let the next getSharp() call re-import. See
 * tests/capture-sharp-optional.test.cjs.
 */
export function __setSharpForTesting(
	value: typeof import("sharp") | null | undefined,
): void {
	_sharp = value;
}

// Anthropic vision: 1568px is the recommended optimal width. Height is capped
// generously at 8000px so tall full-page screenshots remain readable rather
// than being squished into a square constraint.
//
// Override via environment variables:
//   SCREENSHOT_MAX_WIDTH=0   -> uncap width (use raw resolution)
//   SCREENSHOT_MAX_HEIGHT=0  -> uncap height
export const MAX_SCREENSHOT_WIDTH = parseScreenshotDimension(process.env.SCREENSHOT_MAX_WIDTH, 1568);
export const MAX_SCREENSHOT_HEIGHT = parseScreenshotDimension(process.env.SCREENSHOT_MAX_HEIGHT, 8000);

/** Parse a dimension env var: positive int = that value, 0 = Infinity (uncapped), absent/invalid = default. */
function parseScreenshotDimension(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const n = parseInt(value, 10);
	if (isNaN(n) || n < 0) return fallback;
	if (n === 0) return Infinity;
	return n;
}

export async function getScreenshotBufferDimensions(
	buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
	const sharp = await getSharp();
	if (!sharp) return null;

	const meta = await sharp(buffer).metadata();
	if (meta.width === undefined || meta.height === undefined) return null;
	return { width: meta.width, height: meta.height };
}

/**
 * Constrain screenshot dimensions for the Anthropic vision API.
 * Width is capped at 1568px (optimal) and height at 8000px, each
 * independently, using `fit: "inside"` so aspect ratio is preserved.
 * Small images are never upscaled.
 *
 * `page` parameter is retained for ToolDeps signature stability (D008)
 * but is no longer used — all processing is server-side via sharp.
 */
export async function constrainScreenshot(
	_page: Page | null,
	buffer: Buffer,
	mimeType: string,
	quality: number,
): Promise<Buffer> {
	const sharp = await getSharp();
	if (!sharp) return buffer;

	const dimensions = await getScreenshotBufferDimensions(buffer);
	const width = dimensions?.width;
	const height = dimensions?.height;

	if (width === undefined || height === undefined) return buffer;
	if (width <= MAX_SCREENSHOT_WIDTH && height <= MAX_SCREENSHOT_HEIGHT) return buffer;

	const resizer = sharp(buffer).resize(MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_HEIGHT, {
		fit: "inside",
		withoutEnlargement: true,
	});

	if (mimeType === "image/png") {
		return Buffer.from(await resizer.png().toBuffer());
	}
	return Buffer.from(await resizer.jpeg({ quality }).toBuffer());
}
