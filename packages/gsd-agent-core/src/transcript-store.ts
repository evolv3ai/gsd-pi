/** Minimal chat message shape for transcript reducers (web + TUI). */
export interface TranscriptChatMessage {
  role: string
  content: unknown
  timestamp?: number
}

export const MAX_TRANSCRIPT_TURNS = 100

export interface CompletedToolExecution {
  id: string
  name: string
  args: Record<string, unknown>
  result?: {
    content?: Array<{ type: string; text?: string }>
    details?: Record<string, unknown>
    isError?: boolean
  }
}

export type TurnSegment =
  | { kind: "thinking"; content: string }
  | { kind: "text"; content: string }
  | { kind: "tool"; tool: CompletedToolExecution }

export interface CompletedTurn {
  segments: TurnSegment[]
  userMessage?: TranscriptChatMessage
}

export interface TranscriptState {
  completedTurns: CompletedTurn[]
  pendingUserMessage: TranscriptChatMessage | null
  currentTurnSegments: TurnSegment[]
  streamingAssistantText: string
  streamingThinkingText: string
}

export function createInitialTranscriptState(): TranscriptState {
  return {
    completedTurns: [],
    pendingUserMessage: null,
    currentTurnSegments: [],
    streamingAssistantText: "",
    streamingThinkingText: "",
  }
}

export function getFlatTranscript(turns: readonly CompletedTurn[]): string[] {
  return turns.map((turn) =>
    turn.segments
      .filter((segment): segment is TurnSegment & { kind: "text" } => segment.kind === "text")
      .map((segment) => segment.content)
      .join(""),
  )
}

export function pushPendingUserMessage(state: TranscriptState, message: TranscriptChatMessage): TranscriptState {
  return {
    ...state,
    pendingUserMessage: message,
  }
}

export function applyTextDelta(state: TranscriptState, delta: string): TranscriptState {
  if (state.streamingThinkingText.length > 0) {
    return {
      ...state,
      currentTurnSegments: [
        ...state.currentTurnSegments,
        { kind: "thinking", content: state.streamingThinkingText },
      ],
      streamingThinkingText: "",
      streamingAssistantText: state.streamingAssistantText + delta,
    }
  }
  return {
    ...state,
    streamingAssistantText: state.streamingAssistantText + delta,
  }
}

export function applyThinkingDelta(state: TranscriptState, delta: string): TranscriptState {
  if (state.streamingAssistantText.length > 0) {
    return {
      ...state,
      currentTurnSegments: [
        ...state.currentTurnSegments,
        { kind: "text", content: state.streamingAssistantText },
      ],
      streamingAssistantText: "",
      streamingThinkingText: state.streamingThinkingText + delta,
    }
  }
  return {
    ...state,
    streamingThinkingText: state.streamingThinkingText + delta,
  }
}

export function finalizeThinkingStream(state: TranscriptState): TranscriptState {
  if (state.streamingThinkingText.length === 0) return state
  return {
    ...state,
    currentTurnSegments: [
      ...state.currentTurnSegments,
      { kind: "thinking", content: state.streamingThinkingText },
    ],
    streamingThinkingText: "",
  }
}

export function appendToolSegment(state: TranscriptState, tool: CompletedToolExecution): TranscriptState {
  return {
    ...state,
    currentTurnSegments: [...state.currentTurnSegments, { kind: "tool", tool }],
  }
}

export function completeTurn(state: TranscriptState): TranscriptState {
  const pendingSegments: TurnSegment[] = []
  if (state.streamingThinkingText.length > 0) {
    pendingSegments.push({ kind: "thinking", content: state.streamingThinkingText })
  }
  if (state.streamingAssistantText.length > 0) {
    pendingSegments.push({ kind: "text", content: state.streamingAssistantText })
  }

  const finalSegments =
    pendingSegments.length > 0
      ? [...state.currentTurnSegments, ...pendingSegments]
      : state.currentTurnSegments

  const fullText = finalSegments
    .filter((segment): segment is TurnSegment & { kind: "text" } => segment.kind === "text")
    .map((segment) => segment.content)
    .join("")

  if (fullText.length === 0 && finalSegments.length === 0) {
    return {
      ...state,
      pendingUserMessage: null,
      streamingThinkingText: "",
      streamingAssistantText: "",
      currentTurnSegments: [],
    }
  }

  const nextTurns: CompletedTurn[] = [
    ...state.completedTurns,
    {
      userMessage: state.pendingUserMessage ?? undefined,
      segments: finalSegments,
    },
  ]
  const overflow = nextTurns.length > MAX_TRANSCRIPT_TURNS ? nextTurns.length - MAX_TRANSCRIPT_TURNS : 0

  return {
    completedTurns: overflow > 0 ? nextTurns.slice(overflow) : nextTurns,
    pendingUserMessage: null,
    currentTurnSegments: [],
    streamingAssistantText: "",
    streamingThinkingText: "",
  }
}

export function resetActiveTurn(state: TranscriptState): TranscriptState {
  return {
    ...state,
    currentTurnSegments: [],
    streamingAssistantText: "",
    streamingThinkingText: "",
  }
}

export function pickTranscriptState(state: {
  completedTurns: CompletedTurn[]
  pendingUserMessage: TranscriptChatMessage | null
  currentTurnSegments: TurnSegment[]
  streamingAssistantText: string
  streamingThinkingText: string
}): TranscriptState {
  return {
    completedTurns: state.completedTurns,
    pendingUserMessage: state.pendingUserMessage,
    currentTurnSegments: state.currentTurnSegments,
    streamingAssistantText: state.streamingAssistantText,
    streamingThinkingText: state.streamingThinkingText,
  }
}
