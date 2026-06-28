import {
  type CommandSurfaceCompactionResult,
  type CommandSurfaceForkMessage,
  type CommandSurfaceGitSummaryState,
  type CommandSurfaceModelOption,
  type CommandSurfaceRecoveryState,
  type CommandSurfaceSessionBrowserState,
  type CommandSurfaceSessionStats,
  type WorkspaceRecoveryDiagnostics,
} from "./command-surface-contract"
import { isGitSummaryResponse, type GitSummaryResponse } from "./git-summary-contract"
import type {
  SessionBrowserNameFilter,
  SessionBrowserResponse,
  SessionBrowserSession,
  SessionBrowserSortMode,
} from "./session-browser-contract"
import type { BridgeRuntimeSnapshot, WorkspaceBootPayload, WorkspaceOnboardingState } from "./gsd-workspace-store"

export function normalizeClientError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function findOnboardingProviderLabel(onboarding: WorkspaceOnboardingState, providerId: string): string {
  return onboarding.required.providers.find((provider) => provider.id === providerId)?.label ?? providerId
}
export function getCurrentModelSelection(
  bridge: BridgeRuntimeSnapshot | null | undefined,
): { provider?: string; modelId?: string } | null {
  const model = bridge?.sessionState?.model
  if (!model) return null
  return {
    provider: model.provider ?? model.providerId,
    modelId: model.id,
  }
}

export function getPreferredOnboardingProviderId(onboarding: WorkspaceOnboardingState | null | undefined): string | null {
  if (!onboarding) return null
  if (onboarding.required.satisfiedBy?.providerId) {
    return onboarding.required.satisfiedBy.providerId
  }

  const recommended = onboarding.required.providers.find((provider) => !provider.configured && provider.recommended)
  if (recommended) return recommended.id

  const firstUnconfigured = onboarding.required.providers.find((provider) => !provider.configured)
  if (firstUnconfigured) return firstUnconfigured.id

  return onboarding.required.providers[0]?.id ?? null
}

export function normalizeAvailableModels(
  payload: unknown,
  currentModel: { provider?: string; modelId?: string } | null,
): CommandSurfaceModelOption[] {
  const models =
    payload &&
    typeof payload === "object" &&
    "models" in payload &&
    Array.isArray((payload as { models?: unknown[] }).models)
      ? (payload as { models: Array<Record<string, unknown>> }).models
      : []

  const results: CommandSurfaceModelOption[] = []
  for (const model of models) {
    const provider =
      typeof model.provider === "string"
        ? model.provider
        : typeof model.providerId === "string"
          ? model.providerId
          : undefined
    const modelId = typeof model.id === "string" ? model.id : undefined
    if (!provider || !modelId) continue
    results.push({
      provider,
      modelId,
      name: typeof model.name === "string" ? model.name : undefined,
      reasoning: Boolean(model.reasoning),
      isCurrent: provider === currentModel?.provider && modelId === currentModel?.modelId,
    })
  }
  return results
    .sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent) || left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId))
}

export function normalizeSessionStats(payload: unknown): CommandSurfaceSessionStats | null {
  if (!payload || typeof payload !== "object") return null
  const stats = payload as Partial<CommandSurfaceSessionStats>
  if (typeof stats.sessionId !== "string") return null

  return {
    sessionFile: typeof stats.sessionFile === "string" ? stats.sessionFile : undefined,
    sessionId: stats.sessionId,
    userMessages: Number(stats.userMessages ?? 0),
    assistantMessages: Number(stats.assistantMessages ?? 0),
    toolCalls: Number(stats.toolCalls ?? 0),
    toolResults: Number(stats.toolResults ?? 0),
    totalMessages: Number(stats.totalMessages ?? 0),
    tokens: {
      input: Number(stats.tokens?.input ?? 0),
      output: Number(stats.tokens?.output ?? 0),
      cacheRead: Number(stats.tokens?.cacheRead ?? 0),
      cacheWrite: Number(stats.tokens?.cacheWrite ?? 0),
      total: Number(stats.tokens?.total ?? 0),
    },
    cost: Number(stats.cost ?? 0),
  }
}

export function normalizeForkMessages(payload: unknown): CommandSurfaceForkMessage[] {
  const messages =
    payload &&
    typeof payload === "object" &&
    "messages" in payload &&
    Array.isArray((payload as { messages?: unknown[] }).messages)
      ? (payload as { messages: Array<Record<string, unknown>> }).messages
      : []

  return messages
    .map((message) => {
      const entryId = typeof message.entryId === "string" ? message.entryId : undefined
      const text = typeof message.text === "string" ? message.text : undefined
      if (!entryId || !text) return null
      return { entryId, text } satisfies CommandSurfaceForkMessage
    })
    .filter((message): message is CommandSurfaceForkMessage => message !== null)
}

export function normalizeCompactionResult(payload: unknown): CommandSurfaceCompactionResult | null {
  if (!payload || typeof payload !== "object") return null
  const result = payload as Partial<CommandSurfaceCompactionResult>
  if (typeof result.summary !== "string" || typeof result.firstKeptEntryId !== "string") return null

  return {
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: Number(result.tokensBefore ?? 0),
    details: result.details,
  }
}

export function normalizeGitSummaryPayload(payload: unknown): GitSummaryResponse | null {
  return isGitSummaryResponse(payload) ? payload : null
}

export function normalizeGitSummaryError(
  current: CommandSurfaceGitSummaryState,
  message: string,
): CommandSurfaceGitSummaryState {
  return {
    ...current,
    pending: false,
    loaded: false,
    error: message,
  }
}

export function normalizeRecoveryDiagnosticsPayload(payload: unknown): WorkspaceRecoveryDiagnostics | null {
  if (!payload || typeof payload !== "object") return null

  const candidate = payload as Partial<WorkspaceRecoveryDiagnostics>
  if (candidate.status !== "ready" && candidate.status !== "unavailable") return null
  if (typeof candidate.loadedAt !== "string") return null
  if (!candidate.project || typeof candidate.project.cwd !== "string") return null
  if (!candidate.summary || typeof candidate.summary.label !== "string" || typeof candidate.summary.detail !== "string") return null
  if (!candidate.bridge || typeof candidate.bridge.phase !== "string") return null
  if (!candidate.validation || typeof candidate.validation.total !== "number") return null
  if (!candidate.doctor || typeof candidate.doctor.total !== "number") return null
  if (!candidate.interruptedRun || typeof candidate.interruptedRun.available !== "boolean") return null
  if (!candidate.actions || !Array.isArray(candidate.actions.browser) || !Array.isArray(candidate.actions.commands)) return null

  return candidate as WorkspaceRecoveryDiagnostics
}

export function createRecoveryStateFromDiagnostics(diagnostics: WorkspaceRecoveryDiagnostics): CommandSurfaceRecoveryState {
  return {
    phase: diagnostics.status === "ready" ? "ready" : "unavailable",
    pending: false,
    loaded: true,
    stale: false,
    diagnostics,
    error: null,
    lastLoadedAt: diagnostics.loadedAt,
    lastInvalidatedAt: null,
    lastFailureAt: null,
  }
}

export function markRecoveryStatePending(current: CommandSurfaceRecoveryState): CommandSurfaceRecoveryState {
  return {
    ...current,
    pending: true,
    error: null,
    phase: current.loaded ? current.phase : "loading",
  }
}

export function markRecoveryStateInvalidated(current: CommandSurfaceRecoveryState): CommandSurfaceRecoveryState {
  if (!current.loaded && !current.error) return current
  return {
    ...current,
    stale: true,
    lastInvalidatedAt: new Date().toISOString(),
  }
}

export function markRecoveryStateFailure(current: CommandSurfaceRecoveryState, message: string): CommandSurfaceRecoveryState {
  return {
    ...current,
    phase: "error",
    pending: false,
    stale: true,
    error: message,
    lastFailureAt: new Date().toISOString(),
  }
}

export function normalizeSessionBrowserPayload(payload: unknown): CommandSurfaceSessionBrowserState | null {
  if (!payload || typeof payload !== "object") return null

  const response = payload as Partial<SessionBrowserResponse>
  const project = response.project
  const query = response.query
  if (!project || !query || !Array.isArray(response.sessions)) return null
  if (project.scope !== "current_project") return null
  if (typeof project.cwd !== "string" || typeof project.sessionsDir !== "string") return null
  if (typeof query.query !== "string" || typeof query.sortMode !== "string" || typeof query.nameFilter !== "string") return null

  const sessions = response.sessions.filter((session): session is SessionBrowserSession => {
    return (
      typeof session?.id === "string" &&
      typeof session?.path === "string" &&
      typeof session?.cwd === "string" &&
      typeof session?.createdAt === "string" &&
      typeof session?.modifiedAt === "string" &&
      typeof session?.messageCount === "number" &&
      typeof session?.firstMessage === "string" &&
      typeof session?.isActive === "boolean" &&
      typeof session?.depth === "number" &&
      typeof session?.isLastInThread === "boolean" &&
      Array.isArray(session?.ancestorHasNextSibling)
    )
  })

  return {
    scope: project.scope,
    projectCwd: project.cwd,
    projectSessionsDir: project.sessionsDir,
    activeSessionPath: typeof project.activeSessionPath === "string" ? project.activeSessionPath : null,
    query: query.query,
    sortMode: query.sortMode as SessionBrowserSortMode,
    nameFilter: query.nameFilter as SessionBrowserNameFilter,
    totalSessions: Number(response.totalSessions ?? sessions.length),
    returnedSessions: Number(response.returnedSessions ?? sessions.length),
    sessions,
    loaded: true,
    error: null,
  }
}

export function getLiveActiveSessionPath(boot: WorkspaceBootPayload | null): string | null {
  return boot?.bridge.activeSessionFile ?? boot?.bridge.sessionState?.sessionFile ?? null
}

export function getLiveActiveSessionName(boot: WorkspaceBootPayload | null): string | undefined {
  const value = boot?.bridge.sessionState?.sessionName?.trim()
  return value ? value : undefined
}

export function overlayLiveBridgeSessionState<T extends { path: string; isActive: boolean; name?: string }>(
  sessions: T[],
  boot: WorkspaceBootPayload | null,
): T[] {
  const activeSessionPath = getLiveActiveSessionPath(boot)
  const activeSessionName = getLiveActiveSessionName(boot)

  return sessions.map((session) => {
    const isActive = activeSessionPath ? session.path === activeSessionPath : session.isActive
    return {
      ...session,
      isActive,
      ...(isActive && activeSessionName ? { name: activeSessionName } : {}),
    }
  })
}

export function syncSessionBrowserStateWithBridge(
  sessionBrowser: CommandSurfaceSessionBrowserState,
  boot: WorkspaceBootPayload | null,
): CommandSurfaceSessionBrowserState {
  return {
    ...sessionBrowser,
    activeSessionPath: getLiveActiveSessionPath(boot),
    sessions: overlayLiveBridgeSessionState(sessionBrowser.sessions, boot),
  }
}

export function patchSessionBrowserSession(
  sessionBrowser: CommandSurfaceSessionBrowserState,
  sessionPath: string,
  patch: Partial<Pick<SessionBrowserSession, "name" | "isActive">>,
): CommandSurfaceSessionBrowserState {
  return {
    ...sessionBrowser,
    activeSessionPath: patch.isActive ? sessionPath : sessionBrowser.activeSessionPath,
    sessions: sessionBrowser.sessions.map((session) =>
      session.path === sessionPath
        ? {
            ...session,
            ...patch,
          }
        : patch.isActive
          ? {
              ...session,
              isActive: false,
            }
          : session,
    ),
  }
}