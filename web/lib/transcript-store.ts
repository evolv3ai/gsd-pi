export {
  MAX_TRANSCRIPT_TURNS,
  appendToolSegment,
  applyTextDelta,
  applyThinkingDelta,
  completeTurn,
  createInitialTranscriptState,
  finalizeThinkingStream,
  getFlatTranscript,
  pushPendingUserMessage,
  resetActiveTurn,
  pickTranscriptState,
  type CompletedToolExecution,
  type CompletedTurn,
  type TranscriptState,
  type TurnSegment,
} from "@gsd/agent-core/transcript-store.js"

export {
  applyExtensionUiSnapshotToWebFields,
  createEmptyExtensionUiSnapshot,
  extensionUiSnapshotFromWebFields,
  type ExtensionUiSnapshot,
  type WebExtensionUiFields,
} from "@gsd/agent-core/extension-ui-snapshot.js"
