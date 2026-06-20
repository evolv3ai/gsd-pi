import type { WorkspaceRecoverySummary } from "./command-surface-contract"
import type {
  AutoDashboardData,
  BootResumableSession,
  LiveStateInvalidationReason,
  LiveStateInvalidationSource,
  WorkspaceBootPayload,
  WorkspaceFreshnessBucket,
  WorkspaceLiveFreshnessState,
  WorkspaceLiveState,
  WorkspaceStoreState,
} from "./gsd-workspace-store"
import type { WorkspaceIndex } from "../../src/shared/workspace-types.ts"

export function createFreshnessBucket(): WorkspaceFreshnessBucket {
  return {
    status: "idle",
    stale: false,
    reloadCount: 0,
    lastRequestedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailure: null,
    invalidatedAt: null,
    invalidationReason: null,
    invalidationSource: null,
  }
}

export function createInitialRecoverySummary(): WorkspaceRecoverySummary {
  return {
    visible: false,
    tone: "healthy",
    label: "Recovery summary pending",
    detail: "Waiting for the first live workspace snapshot.",
    validationCount: 0,
    retryInProgress: false,
    retryAttempt: 0,
    autoRetryEnabled: false,
    isCompacting: false,
    currentUnitId: null,
    freshness: "idle",
    entrypointLabel: "Inspect recovery",
    lastError: null,
  }
}

export function createInitialWorkspaceLiveFreshnessState(): WorkspaceLiveFreshnessState {
  return {
    auto: createFreshnessBucket(),
    workspace: createFreshnessBucket(),
    recovery: createFreshnessBucket(),
    resumableSessions: createFreshnessBucket(),
    gitSummary: createFreshnessBucket(),
    sessionBrowser: createFreshnessBucket(),
    sessionStats: createFreshnessBucket(),
  }
}

export function createInitialWorkspaceLiveState(): WorkspaceLiveState {
  return {
    auto: null,
    workspace: null,
    resumableSessions: [],
    recoverySummary: createInitialRecoverySummary(),
    freshness: createInitialWorkspaceLiveFreshnessState(),
    softBootRefreshCount: 0,
    targetedRefreshCount: 0,
  }
}

export function withFreshnessRequested(bucket: WorkspaceFreshnessBucket): WorkspaceFreshnessBucket {
  return {
    ...bucket,
    status: "refreshing",
    lastRequestedAt: new Date().toISOString(),
    lastFailure: null,
  }
}

export function withFreshnessInvalidated(
  bucket: WorkspaceFreshnessBucket,
  reason: LiveStateInvalidationReason,
  source: LiveStateInvalidationSource,
): WorkspaceFreshnessBucket {
  return {
    ...bucket,
    status: bucket.lastSuccessAt ? "stale" : bucket.status,
    stale: true,
    invalidatedAt: new Date().toISOString(),
    invalidationReason: reason,
    invalidationSource: source,
  }
}

export function withFreshnessSucceeded(bucket: WorkspaceFreshnessBucket): WorkspaceFreshnessBucket {
  return {
    ...bucket,
    status: "fresh",
    stale: false,
    reloadCount: bucket.reloadCount + 1,
    lastSuccessAt: new Date().toISOString(),
    lastFailureAt: null,
    lastFailure: null,
  }
}

export function withFreshnessFailed(bucket: WorkspaceFreshnessBucket, error: string): WorkspaceFreshnessBucket {
  return {
    ...bucket,
    status: "error",
    stale: true,
    lastFailureAt: new Date().toISOString(),
    lastFailure: error,
  }
}

export function getLiveWorkspaceIndex(
  state: Pick<WorkspaceStoreState, "boot" | "live">,
): WorkspaceIndex | null {
  return state.live.workspace ?? state.boot?.workspace ?? null
}

export function getLiveAutoDashboard(
  state: Pick<WorkspaceStoreState, "boot" | "live">,
): AutoDashboardData | null {
  return state.live.auto ?? state.boot?.auto ?? null
}

export function getLiveResumableSessions(
  state: Pick<WorkspaceStoreState, "boot" | "live">,
): BootResumableSession[] {
  return state.live.resumableSessions.length > 0 ? state.live.resumableSessions : state.boot?.resumableSessions ?? []
}

export function createWorkspaceRecoverySummary(state: Pick<WorkspaceStoreState, "boot" | "live">): WorkspaceRecoverySummary {
  const bridge = state.boot?.bridge ?? null
  const workspace = getLiveWorkspaceIndex(state)
  const auto = getLiveAutoDashboard(state)
  const validationCount = workspace?.validationIssues.length ?? 0
  const retryInProgress = Boolean(bridge?.sessionState?.retryInProgress)
  const retryAttempt = bridge?.sessionState?.retryAttempt ?? 0
  const autoRetryEnabled = Boolean(bridge?.sessionState?.autoRetryEnabled)
  const isCompacting = Boolean(bridge?.sessionState?.isCompacting)
  const freshnessBucket = state.live.freshness.recovery
  const freshness =
    freshnessBucket.status === "error"
      ? "error"
      : freshnessBucket.stale
        ? "stale"
        : freshnessBucket.lastSuccessAt
          ? "fresh"
          : "idle"
  const lastError = bridge?.lastError
    ? {
        message: bridge.lastError.message,
        phase: bridge.lastError.phase,
        at: bridge.lastError.at,
      }
    : null

  let tone: WorkspaceRecoverySummary["tone"] = "healthy"
  let label = "Recovery summary healthy"
  let detail = "No retry, compaction, bridge, or validation recovery signals are active."

  if (!workspace && !auto && !bridge) {
    return createInitialRecoverySummary()
  }

  if (lastError || freshness === "error") {
    tone = "danger"
    label = "Recovery attention required"
    detail = lastError?.message ?? freshnessBucket.lastFailure ?? "A targeted live refresh failed."
  } else if (validationCount > 0) {
    tone = "warning"
    label = `Recovery summary: ${validationCount} validation issue${validationCount === 1 ? "" : "s"}`
    detail = "Workspace validation surfaced issues that may need doctor or audit follow-up."
  } else if (retryInProgress) {
    tone = "warning"
    label = `Recovery retry active (attempt ${Math.max(1, retryAttempt)})`
    detail = "The live bridge is retrying the current unit after a transient failure."
  } else if (isCompacting) {
    tone = "warning"
    label = "Recovery compaction active"
    detail = "The live session is compacting context before continuing."
  } else if (freshness === "stale") {
    tone = "warning"
    label = "Recovery summary stale"
    detail = freshnessBucket.invalidationReason
      ? `Waiting for a targeted refresh after ${freshnessBucket.invalidationReason.replaceAll("_", " ")}.`
      : "Waiting for the next targeted refresh."
  }

  return {
    visible: true,
    tone,
    label,
    detail,
    validationCount,
    retryInProgress,
    retryAttempt,
    autoRetryEnabled,
    isCompacting,
    currentUnitId: auto?.currentUnit?.id ?? null,
    freshness,
    entrypointLabel: tone === "danger" || tone === "warning" ? "Inspect recovery" : "Review recovery",
    lastError,
  }
}

export function applyBootToLiveState(
  current: WorkspaceLiveState,
  boot: WorkspaceBootPayload,
  options: { soft?: boolean } = {},
): WorkspaceLiveState {
  const next: WorkspaceLiveState = {
    ...current,
    auto: boot.auto,
    workspace: boot.workspace,
    resumableSessions: boot.resumableSessions,
    freshness: {
      ...current.freshness,
      auto: withFreshnessSucceeded(current.freshness.auto),
      workspace: withFreshnessSucceeded(current.freshness.workspace),
      recovery: withFreshnessSucceeded(current.freshness.recovery),
      resumableSessions: withFreshnessSucceeded(current.freshness.resumableSessions),
    },
    softBootRefreshCount: current.softBootRefreshCount + (options.soft ? 1 : 0),
  }

  next.recoverySummary = createWorkspaceRecoverySummary({ boot, live: next })
  return next
}
