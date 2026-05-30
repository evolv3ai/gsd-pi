import { describe, expect, test } from "vitest";
import { Text } from "@gsd/pi-tui";
import { initTheme, theme } from "../src/theme/theme.js";
import { createReadToolDefinition, READ_TUI_EXPANDED_MAX_LINES } from "../src/core/tools/read.js";
import { stripAnsi } from "../src/utils/ansi.js";

initTheme("dark", false);

describe("read TUI rendering", () => {
	test("truncates expanded read results to the display cap", () => {
		const definition = createReadToolDefinition(process.cwd());
		const content = Array.from({ length: READ_TUI_EXPANDED_MAX_LINES + 2 }, (_, index) => `line-${index + 1}`).join("\n");
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
		expect(rendered).toContain(`line-${READ_TUI_EXPANDED_MAX_LINES}`);
		expect(rendered).not.toContain(`line-${READ_TUI_EXPANDED_MAX_LINES + 1}`);
		expect(rendered).toContain("2 more lines hidden from display");
	});
});
