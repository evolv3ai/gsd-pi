import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@gsd/pi-tui";

import { showConfirm } from "../confirm-ui.js";

function assertFullOuterBorder(lines: string[], width: number): void {
  assert.ok(lines.length >= 2, "dialog must include top and bottom borders");
  for (const [index, line] of lines.entries()) {
    assert.equal(visibleWidth(line), width, `line ${index} must fill dialog width`);
  }
  const top = stripVTControlCharacters(lines[0] ?? "");
  const bottom = stripVTControlCharacters(lines.at(-1) ?? "");
  assert.match(top, /^[╭┌].*[╮┐]$/);
  assert.match(bottom, /^[╰└].*[╯┘]$/);
  for (let index = 1; index < lines.length - 1; index++) {
    const line = stripVTControlCharacters(lines[index] ?? "");
    assert.match(line, /^[│┃├]/, `line ${index} missing left border: ${line}`);
    assert.match(line, /[│┃┤]$/, `line ${index} missing right border: ${line}`);
  }
}

describe("showConfirm", () => {
  it("renders the confirmation prompt inside a full border", async () => {
    let rendered: string[] = [];
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };

    const ctx = {
      hasUI: true,
      ui: {
        custom: async (factory: any) => {
          let resolved: boolean | undefined;
          const component = factory({ requestRender() {} }, theme, null, (value: boolean) => {
            resolved = value;
          });
          rendered = component.render(80);
          component.handleInput("\r");
          return resolved as never;
        },
      },
    };

    const result = await showConfirm(ctx as any, {
      title: "Confirm action",
      message: "Proceed with the change?",
    });

    assert.equal(result, true);
    assertFullOuterBorder(rendered, 80);
    assert.match(stripVTControlCharacters(rendered[0] ?? ""), /Confirm action/);
  });
});
