import assert from "node:assert/strict";

import { visibleWidth } from "@gsd/pi-tui";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function assertFullOuterBorder(lines: string[], width: number): void {
  assert.ok(lines.length >= 2, "dialog must include top and bottom borders");

  for (const [index, line] of lines.entries()) {
    assert.equal(visibleWidth(line), width, `line ${index} must fill dialog width`);
  }

  const top = stripAnsi(lines[0] ?? "");
  const bottom = stripAnsi(lines.at(-1) ?? "");
  assert.match(top, /^[╭┌].*[╮┐]$/, `top border missing full corners: ${top}`);
  assert.match(bottom, /^[╰└].*[╯┘]$/, `bottom border missing full corners: ${bottom}`);

  for (let index = 1; index < lines.length - 1; index++) {
    const line = stripAnsi(lines[index] ?? "");
    assert.match(line, /^[│┃├]/, `line ${index} missing left border: ${line}`);
    assert.match(line, /[│┃┤]$/, `line ${index} missing right border: ${line}`);
  }
}
