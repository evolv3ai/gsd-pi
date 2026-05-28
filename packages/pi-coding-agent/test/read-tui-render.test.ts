import { describe, expect, test } from "vitest";
import { Text } from "@gsd/pi-tui";
import { initTheme, theme } from "../src/theme/theme.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import { stripAnsi } from "../src/utils/ansi.js";

initTheme("dark", false);

describe("read TUI rendering", () => {
	test("shows all expanded read results", () => {
		const definition = createReadToolDefinition(process.cwd());
		const content = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
		const context = {
			args: { path: "big.txt" },
			lastComponent: new Text("", 0, 0),
			cwd: process.cwd(),
			showImages: true,
			isError: false,
			expanded: true,
			isPartial: false,
			toolCallId: "read-1",
			invalidate() {},
			state: {},
			executionStarted: true,
			argsComplete: true,
		};

		const textComponent = definition.renderResult!(
			{ content: [{ type: "text", text: content }], details: undefined, isError: false },
			{ expanded: true, isPartial: false },
			theme,
			context as any,
		) as Text;
		const rendered = stripAnsi(textComponent.render(120).join("\n"));

		expect(rendered).toContain("line-1");
		expect(rendered).toContain("line-50");
		expect(rendered).not.toContain("more lines");
	});
});
