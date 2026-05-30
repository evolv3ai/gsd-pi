import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/core/skill-block.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { renderSkillUserEntryHtml } from "../src/core/export-html/render-skill-entry.ts";
import { escapeHtmlForExport, safeMarkedParse } from "../src/core/export-html/safe-marked.ts";
import { loadVendoredMarked } from "./helpers/load-vendored-marked.ts";

function decodeSessionDataFromHtml(html: string): { entries: Array<{ type: string; message?: { role: string; content: unknown } }> } {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	if (!match) throw new Error("session-data script tag not found in export HTML");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"));
}

describe("export HTML skill block rendering", () => {
	let marked: ReturnType<typeof loadVendoredMarked>;
	beforeAll(() => {
		marked = loadVendoredMarked();
	});

	it("parseSkillBlock strips the skill wrapper and keeps the user prompt", () => {
		const raw =
			'<skill name="review" location="/skills/review/SKILL.md">\n# Review\n\nSteps here.\n</skill>\n\nPlease review this patch.';
		const skillBlock = parseSkillBlock(raw);
		expect(skillBlock).not.toBeNull();
		expect(skillBlock?.name).toBe("review");
		expect(skillBlock?.content).toContain("Steps here.");
		expect(skillBlock?.userMessage).toBe("Please review this patch.");
	});

	it("renders skill invocation and user message as separate sibling blocks", () => {
		const skillBlock = parseSkillBlock(
			'<skill name="lint" location="/skills/lint/SKILL.md">\nRun **lint**.\n</skill>\n\nFix the errors.',
		)!;
		const html = renderSkillUserEntryHtml(skillBlock, marked, "entry-1");

		expect(html).toContain('class="skill-invocation"');
		expect(html).toContain('class="user-message"');
		expect(html).toContain("Fix the errors.");
		expect(html).not.toContain("<skill ");
	});

	it("renders skill content as markdown, not raw escaped text", () => {
		const skillBlock = parseSkillBlock(
			'<skill name="docs" location="/skills/docs/SKILL.md">\nUse `code` here.\n</skill>',
		)!;
		const html = renderSkillUserEntryHtml(skillBlock, marked, "entry-2");

		expect(html).toContain("<code>code</code>");
		expect(html).not.toContain("Use `code` here.");
	});

	it("embeds skill messages in exported session data", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-export-skill-"));
		const sessionPath = join(tempDir, "session.jsonl");
		const skillText =
			'<skill name="ship" location="/skills/ship/SKILL.md">\nShip it.\n</skill>\n\nGo ahead.';
		writeFileSync(
			sessionPath,
			`${JSON.stringify({ type: "session", id: "s1", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n` +
				`${JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: skillText, timestamp: 1 },
				})}\n`,
		);

		const htmlPath = await exportFromFile(sessionPath, join(tempDir, "out.html"));
		const html = readFileSync(htmlPath, "utf-8");
		const data = decodeSessionDataFromHtml(html);
		const userEntry = data.entries.find((e) => e.type === "message" && e.message?.role === "user");
		expect(userEntry?.message?.content).toBe(skillText);

		rmSync(tempDir, { recursive: true, force: true });
	});
});

describe("export HTML markdown link sanitization", () => {
	let marked: ReturnType<typeof loadVendoredMarked>;
	beforeAll(() => {
		marked = loadVendoredMarked();
	});

	it("blocks javascript: links in markdown", () => {
		const html = safeMarkedParse(marked, "[click me](javascript:alert(1))");
		expect(html).not.toMatch(/href\s*=\s*["']javascript:/i);
		expect(html).toContain("click me");
	});

	it("blocks vbscript: links in markdown", () => {
		const html = safeMarkedParse(marked, "[x](vbscript:msgbox(1))");
		expect(html).not.toMatch(/href\s*=\s*["']vbscript:/i);
	});

	it("escapes safe link href attributes", () => {
		const html = safeMarkedParse(marked, '[safe](https://example.com?q="1")');
		expect(html).toContain('href="https://example.com?q=&quot;1&quot;"');
	});

	it("blocks javascript: image sources", () => {
		const html = safeMarkedParse(marked, '![alt](javascript:alert(1))');
		expect(html).not.toMatch(/src\s*=\s*["']javascript:/i);
		expect(html).toContain("alt");
	});

	it("escapes entry IDs and metadata via escapeHtmlForExport", () => {
		const payload = '<img src=x onerror=alert(1)>';
		expect(escapeHtmlForExport(payload)).toBe(
			"&lt;img src=x onerror=alert(1)&gt;",
		);
		expect(escapeHtmlForExport('say "hi"')).toBe("say &quot;hi&quot;");
	});
});
