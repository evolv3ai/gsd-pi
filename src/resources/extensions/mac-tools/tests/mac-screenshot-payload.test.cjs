const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const jiti = require("jiti")(__filename, { interopDefault: true, debug: false });

const { prepareMacScreenshotPayload } = jiti("../index.ts");
const { __setSharpForTesting } = jiti("../../browser-tools/screenshot-constraints.ts");

async function createTestJpeg(width, height) {
	const sharp = require("sharp");
	return sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 128, g: 128, b: 128 },
		},
	})
		.jpeg({ quality: 80 })
		.toBuffer();
}

describe("prepareMacScreenshotPayload", () => {
	afterEach(() => {
		__setSharpForTesting(undefined);
	});

	it("resizes oversized mac screenshots before returning base64 image data", async () => {
		const sharp = require("sharp");
		const input = await createTestJpeg(3000, 2000);

		const result = await prepareMacScreenshotPayload(
			{
				imageData: input.toString("base64"),
				format: "jpeg",
				width: 3000,
				height: 2000,
			},
			0.8,
		);

		const output = Buffer.from(result.imageData, "base64");
		const meta = await sharp(output).metadata();
		assert.equal(result.mimeType, "image/jpeg");
		assert.equal(result.width, 1568);
		assert.ok(result.height > 1000 && result.height < 1100);
		assert.equal(meta.width, result.width);
		assert.equal(meta.height, result.height);
	});

	it("falls back to raw screenshot data and original dimensions when sharp is unavailable", async () => {
		__setSharpForTesting(null);
		const input = await createTestJpeg(3000, 2000);
		const inputBase64 = input.toString("base64");

		const result = await prepareMacScreenshotPayload(
			{
				imageData: inputBase64,
				format: "jpeg",
				width: 3000,
				height: 2000,
			},
			0.8,
		);

		assert.equal(result.imageData, inputBase64);
		assert.equal(result.width, 3000);
		assert.equal(result.height, 2000);
		assert.equal(result.mimeType, "image/jpeg");
	});
});
