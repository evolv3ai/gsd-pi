import type { TerminalLineType, WorkspaceTerminalLine } from "./gsd-workspace-store"

export const MAX_TERMINAL_LINES = 250

export function timestampLabel(date = new Date()): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function createTerminalLine(type: TerminalLineType, content: string): WorkspaceTerminalLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    content,
    timestamp: timestampLabel(),
  }
}

export function withTerminalLine(lines: WorkspaceTerminalLine[], line: WorkspaceTerminalLine): WorkspaceTerminalLine[] {
  return [...lines, line].slice(-MAX_TERMINAL_LINES)
}
