/**
 * ANSI-aware text measurement and slicing.
 *
 * High-performance UTF-16 native implementation with ASCII fast-paths,
 * single-pass ANSI scanning, and proper Unicode grapheme cluster support.
 */

import { native } from "../native.js";
import type { ExtractSegmentsResult, SliceResult } from "./types.js";

export type { ExtractSegmentsResult, SliceResult };
export { EllipsisKind } from "./types.js";

const ansiPattern = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function tabWidthOrDefault(tabWidth?: number): number {
  return Math.min(16, Math.max(1, Math.floor(tabWidth ?? 3)));
}

function stripAnsi(text: string): string {
  return text.replace(ansiPattern, "");
}

function graphemeWidth(grapheme: string, tabWidth?: number): number {
  if (grapheme === "\t") return tabWidthOrDefault(tabWidth);
  if (grapheme === "\n" || grapheme === "\r") return 0;
  const codePoint = grapheme.codePointAt(0) ?? 0;
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

function fallbackVisibleWidth(text: string, tabWidth?: number): number {
  let width = 0;
  for (const { segment } of segmenter.segment(stripAnsi(text))) {
    width += graphemeWidth(segment, tabWidth);
  }
  return width;
}

function fallbackSliceWithWidth(
  line: string,
  startCol: number,
  length: number,
  strict: boolean,
  tabWidth?: number,
): SliceResult {
  const start = Math.max(0, Math.floor(startCol));
  const end = start + Math.max(0, Math.floor(length));
  let col = 0;
  let text = "";
  let width = 0;

  for (const { segment } of segmenter.segment(stripAnsi(line))) {
    const segmentWidth = graphemeWidth(segment, tabWidth);
    const segmentStart = col;
    const segmentEnd = col + segmentWidth;
    col = segmentEnd;

    if (segmentEnd <= start) continue;
    if (segmentStart >= end) break;
    if (strict && (segmentStart < start || segmentEnd > end)) continue;

    text += segment;
    width += segmentWidth;
  }

  return { text, width };
}

function fallbackTruncateToWidth(
  text: string,
  maxWidth: number,
  ellipsisKind: number,
  pad: boolean,
  tabWidth?: number,
): string {
  const width = Math.max(0, Math.floor(maxWidth));
  const plain = stripAnsi(text);
  if (fallbackVisibleWidth(plain, tabWidth) <= width) {
    return pad ? text + " ".repeat(Math.max(0, width - fallbackVisibleWidth(plain, tabWidth))) : text;
  }

  const ellipsis = ellipsisKind === 0 ? "\u2026" : ellipsisKind === 1 ? "..." : "";
  const ellipsisWidth = fallbackVisibleWidth(ellipsis, tabWidth);
  const budget = Math.max(0, width - ellipsisWidth);
  const sliced = fallbackSliceWithWidth(plain, 0, budget, true, tabWidth).text + ellipsis;
  return pad ? sliced + " ".repeat(Math.max(0, width - fallbackVisibleWidth(sliced, tabWidth))) : sliced;
}

function callNative<T>(name: string, args: unknown[], fallback: () => T): T {
  try {
    return (native as Record<string, Function>)[name](...args) as T;
  } catch {
    return fallback();
  }
}

/**
 * Word-wrap text to a visible width, preserving ANSI escape codes across
 * line breaks.
 *
 * Active SGR codes (colors, bold, etc.) are carried to continuation lines.
 * Underline and strikethrough are reset at line ends and restored on the
 * next line.
 */
export function wrapTextWithAnsi(
  text: string,
  width: number,
  tabWidth?: number,
): string[] {
  return callNative("wrapTextWithAnsi", [text, width, tabWidth], () => {
    const targetWidth = Math.max(1, Math.floor(width));
    const lines: string[] = [];
    for (const inputLine of stripAnsi(text).split("\n")) {
      let remaining = inputLine;
      if (remaining.length === 0) {
        lines.push("");
        continue;
      }
      while (fallbackVisibleWidth(remaining, tabWidth) > targetWidth) {
        const slice = fallbackSliceWithWidth(remaining, 0, targetWidth, true, tabWidth).text;
        const breakAt = Math.max(slice.lastIndexOf(" "), 0);
        const line = breakAt > 0 ? slice.slice(0, breakAt) : slice;
        lines.push(line);
        remaining = remaining.slice(line.length).trimStart();
      }
      lines.push(remaining);
    }
    return lines;
  });
}

/**
 * Truncate text to a visible width with an optional ellipsis.
 *
 * @param text       Input string (may contain ANSI codes).
 * @param maxWidth   Maximum visible width in terminal cells.
 * @param ellipsisKind  0 = "\u2026", 1 = "...", 2 = none.
 * @param pad        When true, pad with spaces to exactly `maxWidth`.
 * @param tabWidth   Tab stop width (default 3, range 1-16).
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsisKind: number,
  pad: boolean,
  tabWidth?: number,
): string {
  return callNative("truncateToWidth", [text, maxWidth, ellipsisKind, pad, tabWidth], () =>
    fallbackTruncateToWidth(text, maxWidth, ellipsisKind, pad, tabWidth),
  );
}

/**
 * Slice a range of visible columns from a line.
 *
 * Counts terminal cells (skipping ANSI escapes). When `strict` is true,
 * wide characters that would exceed the range are excluded.
 */
export function sliceWithWidth(
  line: string,
  startCol: number,
  length: number,
  strict: boolean,
  tabWidth?: number,
): SliceResult {
  return callNative("sliceWithWidth", [line, startCol, length, strict, tabWidth], () =>
    fallbackSliceWithWidth(line, startCol, length, strict, tabWidth),
  );
}

/**
 * Extract the before/after segments around an overlay region.
 *
 * ANSI state is tracked so the `after` segment renders correctly even when
 * the overlay truncates styled text.
 */
export function extractSegments(
  line: string,
  beforeEnd: number,
  afterStart: number,
  afterLen: number,
  strictAfter: boolean,
  tabWidth?: number,
): ExtractSegmentsResult {
  return callNative("extractSegments", [line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth], () => {
    const before = fallbackSliceWithWidth(line, 0, beforeEnd, true, tabWidth);
    const after = fallbackSliceWithWidth(line, afterStart, afterLen, strictAfter, tabWidth);
    return {
      before: before.text,
      beforeWidth: before.width,
      after: after.text,
      afterWidth: after.width,
    };
  });
}

/**
 * Strip ANSI escape sequences, remove control characters and lone
 * surrogates, and normalize line endings (CR removed).
 *
 * Returns the original string when no changes are needed (zero-copy).
 */
export function sanitizeText(text: string): string {
  return callNative("sanitizeText", [text], () =>
    stripAnsi(text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""),
  );
}

/**
 * Calculate visible width of text excluding ANSI escape sequences.
 *
 * Tabs count as `tabWidth` cells (default 3).
 */
export function visibleWidth(text: string, tabWidth?: number): number {
  return callNative("visibleWidth", [text, tabWidth], () =>
    fallbackVisibleWidth(text, tabWidth),
  );
}
