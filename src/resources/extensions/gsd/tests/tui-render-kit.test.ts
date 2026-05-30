// Project/App: gsd-pi
// File Purpose: Unit tests for shared GSD TUI render helpers.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@gsd/pi-tui";
import { assertFullOuterBorder } from "./tui-border-assertions.ts";
import {
  padRightVisible,
  renderDialogFrame,
  renderFrame,
  renderKeyHints,
  renderPanel,
  renderProgressBar,
  rightAlign,
  safeLine,
  wrapVisibleText,
  type ThemeLike,
} from "../tui/render-kit.ts";

const theme: ThemeLike = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function assertWidth(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: ${visibleWidth(line)} "${line}"`,
    );
  }
}

describe("tui render kit", () => {
  test("safeLine clamps visible width", () => {
    assert.equal(visibleWidth(safeLine("abcdef", 4)), 4);
    assert.equal(safeLine("abcdef", 0), "");
  });

  test("padRightVisible fills exact visible width", () => {
    const line = padRightVisible("abc", 8);
    assert.equal(visibleWidth(line), 8);
  });

  test("rightAlign keeps output within width", () => {
    for (const width of [10, 40, 80]) {
      assertWidth([rightAlign("left side with overflow", "right side", width)], width);
    }
  });

  test("wrapVisibleText clamps long words and ansi-aware content", () => {
    const lines = wrapVisibleText("https://example.com/" + "a".repeat(120), 24);
    assert.ok(lines.length > 0);
    assertWidth(lines, 24);
  });

  test("renderFrame keeps borders and rows within width", () => {
    for (const width of [3, 40, 80]) {
      assertWidth(renderFrame(theme, ["row", "long ".repeat(40)], width), width);
    }
  });

  test("renderDialogFrame draws a full titled modal border with footer", () => {
    const lines = renderDialogFrame(theme, "Dialog", ["row", "long ".repeat(40)], 40, {
      footer: renderKeyHints(theme, ["esc close"], 36),
    });
    assertWidth(lines, 40);
    assertFullOuterBorder(lines, 40);
    assert.match(lines[0] ?? "", /^╭─ Dialog ─+╮$/);
    assert.ok(lines.some((line) => line.startsWith("│") && line.endsWith("│")));
    assert.ok(lines.some((line) => line.startsWith("├") && line.endsWith("┤")));
    assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
  });

  test("renderPanel stays within width and draws no vertical borders", () => {
    for (const width of [3, 40, 80]) {
      const lines = renderPanel(theme, "Title", ["row", "long ".repeat(40)], width);
      assertWidth(lines, width);
      // The whole point of renderPanel: no `│` side bars on any line, so
      // terminal text selection copies clean content.
      for (const line of lines) {
        assert.ok(!line.includes("│"), `renderPanel line must not contain a vertical bar: "${line}"`);
      }
    }
  });

  test("renderPanel indents body lines so chrome never sits on copyable text", () => {
    const lines = renderPanel(theme, "Title", ["body"], 40);
    // [header, blank, body, footer rule]
    const body = lines[2];
    assert.ok(body.startsWith("  body"), `body should be indented: "${body}"`);
    assert.match(lines[0], /^── Title ─+$/, "header is an inline-titled rule");
    assert.match(lines[lines.length - 1], /^─+$/, "panel closes with a plain rule");
  });

  test("renderKeyHints and renderProgressBar fit caller budgets", () => {
    assert.ok(visibleWidth(renderKeyHints(theme, ["↑↓ scroll", "esc close"], 12)) <= 12);
    assert.equal(visibleWidth(renderProgressBar(theme, 2, 4, 16)), 16);
  });
});
