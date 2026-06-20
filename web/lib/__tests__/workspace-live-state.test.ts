import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type {
  AutoDashboardData,
  BridgeRuntimeSnapshot,
  WorkspaceBootPayload,
  WorkspaceLiveState,
  WorkspaceStoreState,
} from "../gsd-workspace-store"
import type { WorkspaceIndex } from "../../../src/shared/workspace-types.ts"

import {
  applyBootToLiveState,
  createInitialWorkspaceLiveState,
  createWorkspaceRecoverySummary,
  withFreshnessInvalidated,
  withFreshnessSucceeded,
} from "../workspace-live-state.ts"

function createAuto(overrides: Partial<AutoDashboardData> = {}): AutoDashboardData {
  return {
    active: true,
    paused: false,
    stepMode: false,
    startTime: 100,
    elapsed: 2500,
    currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 100 },
    completedUnits: [],
    basePath: "/repo",
    totalCost: 1.25,
    totalTokens: 1200,
    ...overrides,
  }
}

function createWorkspace(overrides: Partial<WorkspaceIndex> = {}): WorkspaceIndex {
  return {
    projectRoot: "/repo",
    generatedAt: "2026-06-08T00:00:00.000Z",
    active: {
      phase: "execute-task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
    },
    milestones: [],
    validationIssues: [],
    ...overrides,
  } as WorkspaceIndex
}

function createBridge(overrides: Partial<BridgeRuntimeSnapshot> = {}): BridgeRuntimeSnapshot {
  return {
    phase: "ready",
    projectCwd: "/repo",
    projectSessionsDir: "/repo/.gsd/sessions",
    packageRoot: "/pkg",
    startedAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:01.000Z",
    connectionCount: 1,
    lastCommandType: null,
    activeSessionId: "session-1",
    activeSessionFile: "/repo/.gsd/sessions/session-1.jsonl",
    sessionState: {
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: "session-1",
      autoCompactionEnabled: true,
      autoRetryEnabled: false,
      retryInProgress: false,
      retryAttempt: 0,
      messageCount: 4,
      pendingMessageCount: 0,
    },
    lastError: null,
    ...overrides,
  }
}

function createBoot(overrides: Partial<WorkspaceBootPayload> = {}): WorkspaceBootPayload {
  return {
    project: {
      cwd: "/repo",
      sessionsDir: "/repo/.gsd/sessions",
      packageRoot: "/pkg",
    },
    workspace: createWorkspace(),
    auto: createAuto(),
    onboarding: {
      status: "ready",
      locked: false,
    },
    onboardingNeeded: false,
    resumableSessions: [{ id: "session-1", path: "/repo/.gsd/sessions/session-1.jsonl", cwd: "/repo", createdAt: "", modifiedAt: "", messageCount: 4, isActive: true }],
    bridge: createBridge(),
    ...overrides,
  } as WorkspaceBootPayload
}

describe("workspace-live-state", () => {
  test("initial live state creates independent freshness buckets", () => {
    const live = createInitialWorkspaceLiveState()

    assert.equal(live.auto, null)
    assert.equal(live.workspace, null)
    assert.equal(live.recoverySummary.visible, false)
    assert.notEqual(live.freshness.auto, live.freshness.workspace)
    assert.notEqual(live.freshness.recovery, live.freshness.sessionStats)
  })

  test("freshness invalidation marks successful buckets stale without erasing success time", () => {
    const fresh = withFreshnessSucceeded(createInitialWorkspaceLiveState().freshness.workspace)
    const invalidated = withFreshnessInvalidated(fresh, "turn_end", "bridge_event")

    assert.equal(invalidated.status, "stale")
    assert.equal(invalidated.stale, true)
    assert.equal(invalidated.invalidationReason, "turn_end")
    assert.equal(invalidated.invalidationSource, "bridge_event")
    assert.equal(invalidated.lastSuccessAt, fresh.lastSuccessAt)
  })

  test("applyBootToLiveState copies boot data and refreshes recovery summary", () => {
    const boot = createBoot()
    const live = applyBootToLiveState(createInitialWorkspaceLiveState(), boot, { soft: true })

    assert.equal(live.auto, boot.auto)
    assert.equal(live.workspace, boot.workspace)
    assert.equal(live.resumableSessions, boot.resumableSessions)
    assert.equal(live.softBootRefreshCount, 1)
    assert.equal(live.freshness.auto.status, "fresh")
    assert.equal(live.recoverySummary.visible, true)
    assert.equal(live.recoverySummary.currentUnitId, "M001/S01/T01")
  })

  test("recovery summary prioritizes bridge errors over healthy live data", () => {
    const boot = createBoot({
      bridge: createBridge({
        lastError: {
          message: "bridge failed",
          at: "2026-06-08T00:00:02.000Z",
          phase: "failed",
          afterSessionAttachment: true,
        },
      }),
    })
    const live: WorkspaceLiveState = {
      ...createInitialWorkspaceLiveState(),
      auto: boot.auto,
      workspace: boot.workspace,
    }
    const summary = createWorkspaceRecoverySummary({ boot, live } satisfies Pick<WorkspaceStoreState, "boot" | "live">)

    assert.equal(summary.tone, "danger")
    assert.equal(summary.label, "Recovery attention required")
    assert.equal(summary.detail, "bridge failed")
  })
})
