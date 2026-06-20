import test from "node:test"
import assert from "node:assert/strict"

import type { WorkspaceTerminalLine } from "../gsd-workspace-store"

import {
  createTerminalLine,
  MAX_TERMINAL_LINES,
  timestampLabel,
  withTerminalLine,
} from "../workspace-terminal-log.ts"

test("timestampLabel renders stable clock labels", () => {
  const label = timestampLabel(new Date("2026-06-08T09:04:05.000Z"))

  assert.match(label, /^\d{2}:\d{2}:\d{2}$/)
})

test("withTerminalLine appends and caps terminal history", () => {
  const lines: WorkspaceTerminalLine[] = Array.from({ length: MAX_TERMINAL_LINES }, (_, index) => ({
    id: String(index),
    type: "system",
    content: `line ${index}`,
    timestamp: "00:00:00",
  }))
  const next = withTerminalLine(lines, createTerminalLine("success", "new line"))

  assert.equal(next.length, MAX_TERMINAL_LINES)
  assert.equal(next[0].content, "line 1")
  assert.equal(next.at(-1)?.content, "new line")
  assert.equal(next.at(-1)?.type, "success")
})
