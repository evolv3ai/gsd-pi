// gsd-pi — Regression test for next-action-ui ctx.hasUI short-circuit (bare /gsd lockup)

/**
 * Regression test for the bare /gsd lockup investigated in
 * .planning/reports/2026-04-30-gsd-bare-and-new-project-investigation.md.
 *
 * showNextAction() awaits ctx.ui.custom() to render a TUI prompt. In a
 * headless context (no UI bound, ctx.hasUI === false), both ctx.ui.custom
 * and ctx.ui.select resolve to undefined, but the call still pays for two
 * sequential awaits before reaching the safe "not_yet" default. This test
 * asserts the proactive short-circuit: when ctx.hasUI is false,
 * showNextAction returns "not_yet" immediately without touching either
 * UI method.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@gsd/pi-tui";

import { showNextAction } from "../next-action-ui.js";

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

describe("showNextAction ctx.hasUI guard (#5125 lockup root protection)", () => {
  it("returns 'not_yet' immediately when ctx.hasUI is false (no UI calls)", async () => {
    let customCalled = 0;
    let selectCalled = 0;
    const notifications: Array<{ message: string; type: string }> = [];

    const ctx = {
      hasUI: false,
      ui: {
        notify: (message: string, type: string) => {
          notifications.push({ message, type });
        },
        custom: async () => {
          customCalled++;
          return undefined as never;
        },
        select: async () => {
          selectCalled++;
          return undefined;
        },
      },
    };

    const result = await showNextAction(ctx as any, {
      title: "GSD — test",
      actions: [
        { id: "a", label: "Option A", description: "first", recommended: true },
        { id: "b", label: "Option B", description: "second" },
      ],
    });

    assert.equal(result, "not_yet", "should short-circuit to safe default");
    assert.equal(customCalled, 0, "ctx.ui.custom must not be called when hasUI is false");
    assert.equal(selectCalled, 0, "ctx.ui.select must not be called when hasUI is false");
    assert.equal(notifications.length, 1, "should warn when menu cannot be shown");
    assert.match(notifications[0]!.message, /menu could not be shown/);
  });

  it("uses ctx.ui.select fallback when ctx.hasUI is true and custom returns undefined", async () => {
    let customCalled = 0;
    let selectCalled = 0;

    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => {
          customCalled++;
          return undefined as never;
        },
        select: async (_title: string, options: string[]) => {
          selectCalled++;
          return options[0];
        },
      },
    };

    const result = await showNextAction(ctx as any, {
      title: "GSD — test",
      actions: [
        { id: "alpha", label: "Alpha", description: "first", recommended: true },
        { id: "beta", label: "Beta", description: "second" },
      ],
    });

    assert.equal(customCalled, 1, "ctx.ui.custom must be tried first when hasUI is true");
    assert.equal(selectCalled, 1, "ctx.ui.select must run as fallback when custom returns undefined");
    assert.equal(result, "alpha", "fallback should map the picked label back to the chosen action id");
  });

  it("returns 'not_yet' immediately when UI mode is rpc even if ctx.hasUI is true", async () => {
    let customCalled = 0;
    let selectCalled = 0;
    const notifications: Array<{ message: string; type: string }> = [];

    const ctx = {
      hasUI: true,
      ui: {
        mode: "rpc",
        notify: (message: string, type: string) => {
          notifications.push({ message, type });
        },
        custom: async () => {
          customCalled++;
          return undefined as never;
        },
        select: async () => {
          selectCalled++;
          return undefined;
        },
      },
    };

    const result = await showNextAction(ctx as any, {
      title: "GSD — test",
      actions: [
        { id: "alpha", label: "Alpha", description: "first", recommended: true },
        { id: "beta", label: "Beta", description: "second" },
      ],
    });

    assert.equal(result, "not_yet", "rpc-backed UI is non-interactive for next-action");
    assert.equal(customCalled, 0, "ctx.ui.custom must not be called in rpc mode");
    assert.equal(selectCalled, 0, "ctx.ui.select must not be called in rpc mode");
    assert.equal(notifications.length, 1, "should warn when rpc mode blocks menu");
  });

  it("returns the resolved id when ctx.ui.custom completes normally", async () => {
    let selectCalled = 0;

    const ctx = {
      hasUI: true,
      ui: {
        custom: async (_factory: any) => {
          // Simulate user selecting action "beta" via the TUI widget.
          return "beta" as never;
        },
        select: async () => {
          selectCalled++;
          return undefined;
        },
      },
    };

    const result = await showNextAction(ctx as any, {
      title: "GSD — test",
      actions: [
        { id: "alpha", label: "Alpha", description: "first", recommended: true },
        { id: "beta", label: "Beta", description: "second" },
      ],
    });

    assert.equal(result, "beta", "TUI selection should be returned verbatim");
    assert.equal(selectCalled, 0, "ctx.ui.select fallback must NOT fire when custom returns a value");
  });

  it("renders the interactive next-action menu inside a full border", async () => {
    let rendered: string[] = [];
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };

    const ctx = {
      hasUI: true,
      ui: {
        custom: async (factory: any) => {
          let resolved: string | undefined;
          const component = factory({ requestRender() {} }, theme, null, (value: string) => {
            resolved = value;
          });
          rendered = component.render(80);
          component.handleInput("\r");
          return resolved as never;
        },
        select: async () => undefined,
      },
    };

    const result = await showNextAction(ctx as any, {
      title: "GSD — test",
      summary: ["summary"],
      actions: [
        { id: "alpha", label: "Alpha", description: "first", recommended: true },
        { id: "beta", label: "Beta", description: "second" },
      ],
    });

    assert.equal(result, "alpha");
    assertFullOuterBorder(rendered, 80);
    assert.match(stripVTControlCharacters(rendered[0] ?? ""), /GSD Next Action/);
  });
});
