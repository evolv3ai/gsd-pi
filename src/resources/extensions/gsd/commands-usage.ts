/**
 * GSD Command — /gsd usage
 *
 * Shows current LLM context window usage and session token totals.
 */

import type { ExtensionCommandContext, ContextUsage, SessionEntry, Theme } from "@gsd/pi-coding-agent";
import { Key, matchesKey } from "@gsd/pi-tui";

import { formatCost, formatPercent, formatTokenCount } from "./metrics.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { renderDialogFrame, renderKeyHints } from "./tui/render-kit.js";

export interface SessionTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

export function scanSessionTokenTotals(
  entries: ReadonlyArray<SessionEntry> | null | undefined,
): SessionTokenTotals {
  const totals: SessionTokenTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
  };

  if (!entries || entries.length === 0) return totals;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "user") {
      totals.userMessages++;
      continue;
    }

    if (msg.role !== "assistant") continue;

    totals.assistantMessages++;
    const usage = msg.usage;
    if (usage) {
      totals.input += Number(usage.input ?? 0);
      totals.output += Number(usage.output ?? 0);
      totals.cacheRead += Number(usage.cacheRead ?? 0);
      totals.cacheWrite += Number(usage.cacheWrite ?? 0);
      totals.total += Number(usage.totalTokens ?? 0);
      const rawCost = usage.cost;
      if (rawCost != null) {
        totals.cost += typeof rawCost === "number" ? rawCost : Number((rawCost as { total?: number }).total ?? 0);
      }
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "toolCall") {
          totals.toolCalls++;
        }
      }
    }
  }

  if (totals.total === 0) {
    totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  }

  return totals;
}

function formatContextLine(usage: ContextUsage | undefined): string[] {
  if (!usage) {
    return ["Context: unavailable (no active model)"];
  }

  const windowTokens = usage.contextWindow;
  const lines: string[] = [`Window: ${formatTokenCount(windowTokens)} tokens`];

  if (usage.tokens == null || usage.percent == null) {
    lines.push("In context: unknown (after compaction — wait for the next model response)");
    return lines;
  }

  const remaining = Math.max(0, windowTokens - usage.tokens);
  lines.push(`In context: ${formatTokenCount(usage.tokens)} tokens (${formatPercent(usage.percent)}%)`);
  lines.push(`Remaining: ${formatTokenCount(remaining)} tokens`);
  return lines;
}

function formatThresholdLines(): string[] {
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  const lines: string[] = [];

  const pauseThreshold = prefs?.context_pause_threshold;
  if (typeof pauseThreshold === "number" && pauseThreshold > 0) {
    lines.push(`Auto pause: ${pauseThreshold}%`);
  }

  const compactionThreshold = prefs?.context_management?.compaction_threshold_percent;
  if (typeof compactionThreshold === "number") {
    lines.push(`Compaction: ${Math.round(compactionThreshold * 100)}%`);
  }

  return lines;
}

export function formatUsageReport(options: {
  modelLabel: string | null;
  contextUsage: ContextUsage | undefined;
  sessionTotals: SessionTokenTotals;
}): string {
  const lines: string[] = ["Context Usage", ""];

  if (options.modelLabel) {
    lines.push(`Model: ${options.modelLabel}`);
  }

  lines.push(...formatContextLine(options.contextUsage));
  lines.push("");

  const { sessionTotals } = options;
  lines.push("Session totals");
  lines.push(`  Input: ${formatTokenCount(sessionTotals.input)}  Output: ${formatTokenCount(sessionTotals.output)}`);
  if (sessionTotals.cacheRead > 0 || sessionTotals.cacheWrite > 0) {
    lines.push(
      `  Cache read: ${formatTokenCount(sessionTotals.cacheRead)}  Cache write: ${formatTokenCount(sessionTotals.cacheWrite)}`,
    );
  }
  if (sessionTotals.cost > 0) {
    lines.push(`  Cost: ${formatCost(sessionTotals.cost)}`);
  }
  lines.push(
    `  Messages: ${sessionTotals.userMessages} user / ${sessionTotals.assistantMessages} assistant`,
  );
  if (sessionTotals.toolCalls > 0) {
    lines.push(`  Tool calls: ${sessionTotals.toolCalls}`);
  }

  const thresholdLines = formatThresholdLines();
  if (thresholdLines.length > 0) {
    lines.push("");
    lines.push("Thresholds");
    for (const line of thresholdLines) {
      lines.push(`  ${line}`);
    }
  }

  return lines.join("\n");
}

async function showUsageDialog(
  ctx: ExtensionCommandContext,
  reportText: string,
): Promise<boolean | undefined> {
  return ctx.ui.custom<boolean>((tui, theme: Theme, _kb, done) => {
    let cachedLines: string[] | undefined;
    let cachedWidth: number | undefined;
    let cachedRows: number | undefined;
    let cachedScrollOffset: number | undefined;
    let scrollOffset = 0;
    let lastMaxScroll = 0;
    let lastVisibleRows = 1;

    function render(width: number): string[] {
      const terminalRows = process.stdout.rows || 0;
      if (
        cachedLines &&
        cachedWidth === width &&
        cachedRows === terminalRows &&
        cachedScrollOffset === scrollOffset
      ) {
        return cachedLines;
      }

      const contentWidth = Math.max(1, width - 4);
      const body = reportText.split("\n");
      if (body[0] === "Context Usage") body.shift();
      while (body[0] === "") body.shift();
      const maxOverlayRows = terminalRows > 0 ? Math.max(5, Math.floor(terminalRows * 0.8)) : 24;
      const frameRows = 4;
      const visibleRows = Math.max(1, maxOverlayRows - frameRows);
      const maxScroll = Math.max(0, body.length - visibleRows);
      scrollOffset = Math.min(Math.max(scrollOffset, 0), maxScroll);
      lastMaxScroll = maxScroll;
      lastVisibleRows = visibleRows;
      const visible = body.slice(scrollOffset, scrollOffset + visibleRows);
      const scrollable = body.length > visibleRows;

      cachedLines = renderDialogFrame(theme, "Context Usage", visible, width, {
        footer: renderKeyHints(theme, scrollable ? ["↑↓ scroll", "any key close"] : ["any key close"], contentWidth),
        scroll: { offset: scrollOffset, visibleRows, totalRows: body.length },
      });
      cachedWidth = width;
      cachedRows = terminalRows;
      cachedScrollOffset = scrollOffset;
      return cachedLines;
    }

    function scrollBy(delta: number): boolean {
      if (lastMaxScroll <= 0) return false;
      const nextOffset = Math.min(Math.max(scrollOffset + delta, 0), lastMaxScroll);
      if (nextOffset !== scrollOffset) {
        scrollOffset = nextOffset;
        cachedLines = undefined;
        cachedScrollOffset = undefined;
        tui.requestRender();
      }
      return true;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
        cachedWidth = undefined;
        cachedRows = undefined;
        cachedScrollOffset = undefined;
      },
      handleInput: (data: string) => {
        if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
          if (scrollBy(1)) return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
          if (scrollBy(-1)) return;
        }
        if (matchesKey(data, Key.pageDown)) {
          if (scrollBy(lastVisibleRows)) return;
        }
        if (matchesKey(data, Key.pageUp)) {
          if (scrollBy(-lastVisibleRows)) return;
        }
        done(true);
      },
    };
  }, {
    overlay: true,
    overlayOptions: {
      width: "70%",
      minWidth: 64,
      maxHeight: "80%",
      anchor: "center",
    },
  });
}

export async function handleUsage(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const contextUsage = ctx.getContextUsage?.();
  const sessionTotals = scanSessionTokenTotals(ctx.sessionManager.getEntries());
  const model = ctx.model;
  const modelLabel = model ? `${model.provider}/${model.id}` : null;

  if (args.includes("--json")) {
    const prefs = loadEffectiveGSDPreferences()?.preferences;
    ctx.ui.notify(
      JSON.stringify(
        {
          model: modelLabel,
          contextUsage: contextUsage ?? null,
          sessionTotals,
          thresholds: {
            contextPause: prefs?.context_pause_threshold ?? null,
            compaction: prefs?.context_management?.compaction_threshold_percent ?? null,
          },
        },
        null,
        2,
      ),
      "info",
    );
    return;
  }

  const reportText = formatUsageReport({ modelLabel, contextUsage, sessionTotals });

  if (ctx.hasUI) {
    try {
      const result = await showUsageDialog(ctx, reportText);
      if (result !== undefined) return;
    } catch {
      // Fall back to text notify below when custom overlays are unavailable.
    }
  }

  ctx.ui.notify(reportText, "info");
}
