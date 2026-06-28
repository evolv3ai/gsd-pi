import type {
  AgentEndEvent,
  ExtensionUiRequestEvent,
  LiveStateInvalidationEvent,
  MessageUpdateEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  TurnEndEvent,
  WorkspaceEvent,
} from "./gsd-workspace-store"

export interface LiveInteractionHandlers {
  onExtensionUiRequest(event: ExtensionUiRequestEvent): void
  onMessageUpdate(event: MessageUpdateEvent): void
  onTurnBoundary(): void
  onToolExecutionStart(event: ToolExecutionStartEvent): void
  onToolExecutionUpdate(event: ToolExecutionUpdateEvent): void
  onToolExecutionEnd(event: ToolExecutionEndEvent): void
}

export function routeLiveInteractionEvent(event: WorkspaceEvent, handlers: LiveInteractionHandlers): void {
  switch (event.type) {
    case "extension_ui_request":
      handlers.onExtensionUiRequest(event as ExtensionUiRequestEvent)
      break
    case "message_update":
      handlers.onMessageUpdate(event as MessageUpdateEvent)
      break
    case "agent_end":
    case "turn_end":
      handlers.onTurnBoundary()
      break
    case "tool_execution_start":
      handlers.onToolExecutionStart(event as ToolExecutionStartEvent)
      break
    case "tool_execution_update":
      handlers.onToolExecutionUpdate(event as ToolExecutionUpdateEvent)
      break
    case "tool_execution_end":
      handlers.onToolExecutionEnd(event as ToolExecutionEndEvent)
      break
    case "bridge_status":
    case "live_state_invalidation":
    case "extension_error":
      break
  }
}

export interface WorkspaceEventCoordinator {
  onLastEventType(type: WorkspaceEvent["type"]): void
  onBridgeStatus(event: Extract<WorkspaceEvent, { type: "bridge_status" }>): void
  onLiveStateInvalidation(event: LiveStateInvalidationEvent): void
  onLiveInteraction(event: WorkspaceEvent): void
  onTerminalSummary(summary: { type: string; message: string }): void
}

export function dispatchWorkspaceEvent(
  event: WorkspaceEvent,
  coordinator: WorkspaceEventCoordinator,
  summarize: (event: WorkspaceEvent) => { type: string; message: string } | null,
): void {
  coordinator.onLastEventType(event.type)

  if (event.type === "bridge_status") {
    coordinator.onBridgeStatus(event)
    return
  }

  if (event.type === "live_state_invalidation") {
    coordinator.onLiveStateInvalidation(event)
  }

  coordinator.onLiveInteraction(event)

  const summary = summarize(event)
  if (summary) {
    coordinator.onTerminalSummary(summary)
  }
}

export type TurnBoundaryEvent = AgentEndEvent | TurnEndEvent
