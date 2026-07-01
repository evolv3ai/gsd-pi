import type { WorkspaceRecoverySummary } from "./command-surface-contract"
import type {
  AutoDashboardData,
  BootResumableSession,
  LiveStateInvalidationReason,
  LiveStateInvalidationSource,
  WorkspaceBootPayload,
  WorkspaceFreshnessBucket,
  WorkspaceFreshnessStatus,
  WorkspaceLiveFreshnessState,
  WorkspaceLiveState,
  WorkspaceStoreState,
} from "./gsd-workspace-store"
import type { WorkspaceIndex } from "../../src/shared/workspace-types.ts"

export type EntitySlice<T> = WorkspaceFreshnessBucket & {
  data: T | null
}

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

export function createEntitySlice<T>(data: T | null = null): EntitySlice<T> {
  return {
    data,
    ...createFreshnessBucket(),
  }
}

export function withEntitySliceRequested<T>(slice: EntitySlice<T>): EntitySlice<T> {
  return {
    ...withFreshnessRequested(slice),
    data: slice.data,
  }
}

export function withEntitySliceInvalidated<T>(
  slice: EntitySlice<T>,
  reason: LiveStateInvalidationReason,
  source: LiveStateInvalidationSource,
): EntitySlice<T> {
  return {
    ...withFreshnessInvalidated(slice, reason, source),
    data: slice.data,
  }
}

export function withEntitySliceSucceeded<T>(slice: EntitySlice<T>, data?: T): EntitySlice<T> {
  return {
    ...withFreshnessSucceeded(slice),
    data: data !== undefined ? data : slice.data,
  }
}

export function withEntitySliceFailed<T>(slice: EntitySlice<T>, error: string): EntitySlice<T> {
  return {
    ...withFreshnessFailed(slice, error),
    data: slice.data,
  }
}

export function resolveWorkspaceIndex(state: Pick<WorkspaceStoreState, "boot" | "live">): WorkspaceIndex | null {
  return state.live.workspace.data ?? state.boot?.workspace ?? null
}

export function resolveAutoDashboard(state: Pick<WorkspaceStoreState, "boot" | "live">): AutoDashboardData | null {
  return state.live.auto.data ?? state.boot?.auto ?? null
}

export function resolveResumableSessions(state: Pick<WorkspaceStoreState, "boot" | "live">): BootResumableSession[] {
  const liveSessions = state.live.resumableSessions.data
  if (liveSessions && liveSessions.length > 0) return liveSessions
  return state.boot?.resumableSessions ?? []
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
    recovery: createFreshnessBucket(),
    gitSummary: createFreshnessBucket(),
    sessionBrowser: createFreshnessBucket(),
    sessionStats: createFreshnessBucket(),
  }
}

export function createInitialWorkspaceLiveState(): WorkspaceLiveState {
  return {
    auto: createEntitySlice<AutoDashboardData>(),
    workspace: createEntitySlice<WorkspaceIndex>(),
    resumableSessions: createEntitySlice<BootResumableSession[]>([]),
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

export function createWorkspaceRecoverySummary(state: Pick<WorkspaceStoreState, "boot" | "live">): WorkspaceRecoverySummary {
  const bridge = state.boot?.bridge ?? null
  const workspace = resolveWorkspaceIndex(state)
  const auto = resolveAutoDashboard(state)
  const validationCount = workspace?.validationIssues.length ?? 0
  const retryInProgress = Boolean(bridge?.sessionState?.retryInProgress)
  const retryAttempt = bridge?.sessionState?.retryAttempt ?? 0
  const autoRetryEnabled = Boolean(bridge?.sessionState?.autoRetryEnabled)
  const isCompacting = Boolean(bridge?.sessionState?.isCompacting)
  const freshnessBucket = state.live.freshness.recovery
  const freshness: WorkspaceFreshnessStatus =
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
    auto: withEntitySliceSucceeded(current.auto, boot.auto),
    workspace: withEntitySliceSucceeded(current.workspace, boot.workspace),
    resumableSessions: withEntitySliceSucceeded(current.resumableSessions, boot.resumableSessions),
    freshness: {
      ...current.freshness,
      recovery: withFreshnessSucceeded(current.freshness.recovery),
    },
    softBootRefreshCount: current.softBootRefreshCount + (options.soft ? 1 : 0),
  }

  next.recoverySummary = createWorkspaceRecoverySummary({ boot, live: next })
  return next
}
