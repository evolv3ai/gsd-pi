// Project/App: gsd-pi
// File Purpose: Visual contract tests for shared transcript rendering primitives.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { isImageLine, padRight, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { renderConnectedCard, renderStepDots, renderTranscriptCard, formatStepProgress } from "../transcript-design.js";

initTheme("dark", false);

// A Kitty image "block" as the Image component emits it: the sequence on line 0
// then (rows-1) blank padding lines that reserve the image's on-screen height.
const KITTY_SEQ = "\x1b_Ga=T,f=100,q=2,C=1,c=10,r=8,i=42,p=1;AAAA\x1b\\";
function imageBlock(rows: number): string[] {
	return [KITTY_SEQ, ...Array.from({ length: rows - 1 }, () => "")];
}

describe("renderConnectedCard", () => {
	test("keeps long ANSI body rows on the existing width contract", () => {
		const width = 32;
		const indent = 4;
		const line = `\x1b[36m${"abcdef ".repeat(8)}\x1b[0m`;

		const rendered = renderConnectedCard(width, "tool", [line], { indent, closeBottom: false });
		const body = rendered[1];
		const expectedInner = padRight(truncateToWidth("   " + line, width - indent, ""), width - indent);

		assert.ok(body, "expected a body row");
		assert.equal(body, " ".repeat(indent) + expectedInner);
		assert.equal(visibleWidth(body), width);
	});

	test("preserves image padding rows so a tall image does not overflow", () => {
		const rows = 8;
		const body = ["[Image: 800x2400]", "", ...imageBlock(rows)];

		const rendered = renderConnectedCard(80, "READ", body, { closeBottom: true });

		// The image sequence must survive intact (no padRight/truncate corruption)…
		const seqRow = rendered.find((l) => isImageLine(l));
		assert.ok(seqRow, "image sequence row should be present");
		assert.ok(seqRow.includes(KITTY_SEQ), "image sequence must survive verbatim");
		// …but be left-offset to align under the card text (indent + 3 spaces),
		// not hugging column 0.
		assert.ok(seqRow.startsWith(" ".repeat(4) + "   "), "image row should be indented under the card text");

		// The (rows-1) reserved blank padding rows must NOT be trimmed/collapsed.
		const seqIdx = rendered.findIndex((l) => isImageLine(l));
		const bottomIdx = rendered.length - 1; // closing border
		const blanksAfter = rendered.slice(seqIdx + 1, bottomIdx).filter((l) => l.trim().length === 0).length;
		assert.ok(
			blanksAfter >= rows - 1,
			`expected >= ${rows - 1} reserved blank rows after the image, got ${blanksAfter}`,
		);
	});
});

describe("renderStepDots", () => {
	test("renders filled and pending dots for in-progress position mode", () => {
		const plain = stripAnsi(renderStepDots(3, 5, { mode: "position" }));
		assert.equal(plain, "●●●○○");
	});

	test("renders all success dots when complete", () => {
		const plain = stripAnsi(renderStepDots(3, 3, { mode: "position" }));
		assert.equal(plain, "●●●");
	});

	test("completed mode uses only finished count", () => {
		const plain = stripAnsi(renderStepDots(3, 6, { mode: "completed" }));
		assert.equal(plain, "●●●○○○");
	});

	test("formatStepProgress includes label and count", () => {
		const plain = stripAnsi(formatStepProgress("tasks", 2, 5, { mode: "position" }));
		assert.match(plain, /tasks/);
		assert.match(plain, /2\/5/);
		assert.match(plain, /●/);
	});
});

describe("renderTranscriptCard image handling", () => {
	test("does not trim image padding rows", () => {
		const rows = 6;
		const body = ["read /tmp/x.png", "", "[Image: ...]", "", ...imageBlock(rows)];
		const card = renderTranscriptCard(body, 100, { title: "READ", right: "success", tone: "success" });

		const seqIdx = card.findIndex((l) => isImageLine(l));
		assert.ok(seqIdx >= 0, "image sequence should be present in the card");
		const blanksAfter = card.slice(seqIdx + 1, card.length - 1).filter((l) => l.trim().length === 0).length;
		assert.ok(blanksAfter >= rows - 1, `expected >= ${rows - 1} reserved rows, got ${blanksAfter}`);
	});
});
