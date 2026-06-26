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
  renderPlainOutcome,
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

  test("renderPanel keeps body on dedicated lines without vertical borders", () => {
    const lines = renderPanel(theme, "Title", ["body"], 40);
    const body = lines[1];
    assert.match(body, /^body/, `body line should start with copyable text: "${body}"`);
    assert.match(lines[0] ?? "", /^──+ .* ─+$/);
    assert.match(lines.at(-1) ?? "", /^─+$/);
    for (const line of lines) {
      assert.ok(!line.includes("│"), `renderPanel line must not contain a vertical bar: "${line}"`);
    }
  });

  test("renderPlainOutcome uses a chat-style header without rule borders", () => {
    const lines = renderPlainOutcome(
      theme,
      60,
      "✓ Milestone M002 complete",
      ["Dark Mode. Milestone M002 complete.", "Next · Review the closeout."],
    );
    assertWidth(lines, 60);
    assert.match(lines[0] ?? "", /^GSD · /);
    assert.doesNotMatch(lines.join("\n"), /^─/m);
    for (const line of lines) {
      assert.ok(!line.includes("│"), `plain outcome must not use vertical bars: "${line}"`);
    }
  });

  test("renderPlainOutcome spreads header meta and footer commands to the right edge", () => {
    const width = 80;
    const lines = renderPlainOutcome(
      theme,
      width,
      "● Step complete",
      ["Next · Advance one step."],
      {
        headerRight: "2m 05s",
        footerRight: "/gsd next  ·  /gsd auto",
      },
    );
    assertWidth(lines, width);
    const header = lines[0] ?? "";
    const footer = lines.at(-2) ?? "";
    assert.ok(header.endsWith("2m 05s"), `elapsed should be right-aligned: "${header}"`);
    assert.ok(footer.endsWith("/gsd auto"), `commands should be right-aligned: "${footer}"`);
    assert.ok(visibleWidth(header) >= width - 1, "header should use full row width");
  });

  test("renderKeyHints and renderProgressBar fit caller budgets", () => {
    assert.ok(visibleWidth(renderKeyHints(theme, ["↑↓ scroll", "esc close"], 12)) <= 12);
    assert.equal(visibleWidth(renderProgressBar(theme, 2, 4, 16)), 16);
  });
});
