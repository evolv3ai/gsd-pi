// Project/App: gsd-pi
// File Purpose: Shared helpers for GsdStatusWidget progress-strip extension tests.

import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { visibleWidth } from "@gsd/pi-tui";
import type { GsdProgressState } from "@gsd/pi-coding-agent/core/extensions/index.js";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { GsdStatusWidget } from "../../../../../packages/gsd-agent-modes/src/modes/interactive/components/gsd-status-widget.ts";

export type ProgressStripUiMock = {
  widgetCalls: Array<[string, unknown]>;
  getProgressState: () => GsdProgressState | undefined;
  disposeProgress: () => void;
  ui: {
    setWidget(key: string, factory: unknown): void;
    setHeader(): void;
    setStatus(key: string, value?: string): void;
    setGsdProgress(state: GsdProgressState | undefined, dispose?: () => void): void;
  };
};

export function createProgressStripUiMock(): ProgressStripUiMock {
  const widgetCalls: Array<[string, unknown]> = [];
  let progressState: GsdProgressState | undefined;
  let progressDispose: (() => void) | undefined;

  return {
    widgetCalls,
    getProgressState: () => progressState,
    disposeProgress: () => progressDispose?.(),
    ui: {
      setWidget(key: string, factory: unknown) {
        widgetCalls.push([key, factory]);
      },
      setHeader() {},
      setStatus() {},
      setGsdProgress(state: GsdProgressState | undefined, dispose?: () => void) {
        progressState = state;
        if (dispose) progressDispose = dispose;
        widgetCalls.push(["setGsdProgress", state]);
      },
    },
  };
}

export function renderProgressStripLines(
  progress: GsdProgressState,
  width: number,
  options?: { activeToolCount?: number; manuallyExpanded?: boolean; cwd?: string },
): string[] {
  initTheme("dark", false);
  const widget = new GsdStatusWidget(() => ({
    override: "auto",
    activeToolCount: options?.activeToolCount ?? 1,
    cwd: options?.cwd ?? progress.path ?? "/tmp",
    manuallyExpanded: options?.manuallyExpanded ?? progress.widgetMode !== "min",
    gsdProgress: progress,
  }));
  return widget.render(width);
}

export function renderProgressStrip(
  progress: GsdProgressState,
  width: number,
  options?: { activeToolCount?: number; manuallyExpanded?: boolean; cwd?: string },
): string {
  return renderProgressStripLines(progress, width, options).map((line) => stripAnsi(line)).join("\n");
}

export function assertLinesFit(lines: string[], width: number): void {
  for (const line of lines) {
    const plain = stripAnsi(line);
    assert.ok(
      visibleWidth(plain) <= width,
      `line exceeds width ${width}: "${plain}" (${visibleWidth(plain)})`,
    );
  }
}
