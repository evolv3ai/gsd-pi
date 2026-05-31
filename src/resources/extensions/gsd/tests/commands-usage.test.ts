import test from "node:test";
import assert from "node:assert/strict";

import type { SessionEntry } from "@gsd/pi-coding-agent";

import {
  formatUsageReport,
  scanSessionTokenTotals,
  handleUsage,
} from "../commands-usage.ts";
import { assertFullOuterBorder } from "./tui-border-assertions.ts";

const TS = 1;

function sessionEntries(...messages: unknown[]): SessionEntry[] {
  return messages.map((message, i) => ({
    type: "message",
    id: `entry-${i}`,
    parentId: i > 0 ? `entry-${i - 1}` : null,
    timestamp: new Date(TS).toISOString(),
    message,
  })) as unknown as SessionEntry[];
}

test("scanSessionTokenTotals aggregates assistant usage and tool calls", () => {
  const totals = scanSessionTokenTotals(sessionEntries(
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: TS,
    },
    {
      role: "assistant",
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
      },
      content: [
        { type: "toolCall", id: "tc-1", name: "read", arguments: {} },
        { type: "text", text: "done" },
      ],
      timestamp: TS,
    },
  ));

  assert.equal(totals.userMessages, 1);
  assert.equal(totals.assistantMessages, 1);
  assert.equal(totals.input, 1000);
  assert.equal(totals.output, 200);
  assert.equal(totals.cacheRead, 500);
  assert.equal(totals.cacheWrite, 100);
  assert.equal(totals.total, 1800);
  assert.equal(totals.cost, 0.05);
  assert.equal(totals.toolCalls, 1);
});

test("formatUsageReport shows context percent and remaining tokens", () => {
  const report = formatUsageReport({
    modelLabel: "claude-code/claude-sonnet-4-6",
    contextUsage: {
      tokens: 50_000,
      contextWindow: 200_000,
      percent: 25,
    },
    sessionTotals: scanSessionTokenTotals([]),
  });

  assert.match(report, /Model: claude-code\/claude-sonnet-4-6/);
  assert.match(report, /In context: 50\.0k tokens \(25\.0%\)/);
  assert.match(report, /Remaining: 150\.0k tokens/);
});

test("formatUsageReport explains unknown context after compaction", () => {
  const report = formatUsageReport({
    modelLabel: "openai/gpt-5",
    contextUsage: {
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    },
    sessionTotals: scanSessionTokenTotals([]),
  });

  assert.match(report, /In context: unknown \(after compaction/);
});

test("handleUsage emits JSON when --json is passed", async () => {
  const messages: string[] = [];
  const ctx = {
    model: { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000, percent: 5 }),
    sessionManager: { getEntries: () => [] },
    ui: {
      notify(message: string) {
        messages.push(message);
      },
    },
  };

  await handleUsage("--json", ctx as any);

  assert.equal(messages.length, 1);
  const parsed = JSON.parse(messages[0]!);
  assert.equal(parsed.model, "claude-code/claude-sonnet-4-6");
  assert.equal(parsed.contextUsage.tokens, 10_000);
  assert.equal(parsed.sessionTotals.input, 0);
});

test("handleUsage renders interactive usage output inside a full border", async () => {
  let renderFn: ((width: number) => string[]) | undefined;
  const messages: string[] = [];
  const ctx = {
    hasUI: true,
    model: { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000, percent: 5 }),
    sessionManager: { getEntries: () => [] },
    ui: {
      custom: async (factory: any) => {
        const theme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };
        const component = factory({ requestRender: () => {} }, theme, {}, () => {});
        renderFn = component.render;
        return true;
      },
      notify(message: string) {
        messages.push(message);
      },
    },
  };

  await handleUsage("", ctx as any);

  assert.equal(messages.length, 0, "interactive usage should use the dialog instead of notify");
  assert.ok(renderFn, "render function should have been captured");
  const lines = renderFn!(80);
  assertFullOuterBorder(lines, 80);
  assert.match(lines.join("\n"), /claude-code\/claude-sonnet-4-6/);
});

test("handleUsage keeps short-terminal usage dialog scrollable", async () => {
  const originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { value: 10, configurable: true });

  try {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    let closed = false;
    const ctx = {
      hasUI: true,
      model: { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000, percent: 5 }),
      sessionManager: {
        getEntries: () => sessionEntries({
          role: "assistant",
          usage: {
            input: 1000,
            output: 200,
            cacheRead: 500,
            cacheWrite: 100,
            totalTokens: 1800,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
          },
          content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
          timestamp: TS,
        }),
      },
      ui: {
        custom: async (factory: any) => {
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          component = factory({ requestRender: () => {} }, theme, {}, () => {
            closed = true;
          });
          return true;
        },
        notify() {},
      },
    };

    await handleUsage("", ctx as any);

    assert.ok(component, "usage dialog should render via custom UI");
    const initialLines = component.render(80);
    assert.ok(initialLines.length <= 8, `usage dialog should fit 80% terminal height, got ${initialLines.length}`);

    for (let i = 0; i < 10; i++) component.handleInput("\u001b[B");

    assert.equal(closed, false, "scroll keys should not close a scrollable usage dialog");
    assert.match(component.render(80).join("\n"), /Tool calls: 1/);

    component.handleInput("x");
    assert.equal(closed, true, "non-scroll keys should close the usage dialog");
  } finally {
    if (originalRowsDescriptor) {
      Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
    } else {
      delete (process.stdout as { rows?: number }).rows;
    }
  }
});
