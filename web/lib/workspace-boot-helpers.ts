import type {
  BridgeRuntimeSnapshot,
  WorkspaceBootPayload,
  WorkspaceSessionState,
} from "./gsd-workspace-store"
import {
  getLiveActiveSessionPath,
  overlayLiveBridgeSessionState,
} from "./command-surface-helpers"

function shortenPath(path: string | undefined, segmentCount = 3): string {
  if (!path) return "—"
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segmentCount) {
    return path.startsWith("/") ? `/${parts.join("/")}` : parts.join("/")
  }
  const tail = parts.slice(-segmentCount).join("/")
  return `…/${tail}`
}

export function cloneBootWithBridge(
  boot: WorkspaceBootPayload | null,
  bridge: BridgeRuntimeSnapshot,
): WorkspaceBootPayload | null {
  if (!boot) return null
  const nextBoot = {
    ...boot,
    bridge,
  }

  return {
    ...nextBoot,
    resumableSessions: overlayLiveBridgeSessionState(nextBoot.resumableSessions, nextBoot),
  }
}

export function patchBootSessionState(
  boot: WorkspaceBootPayload | null,
  patch: Partial<WorkspaceSessionState>,
): WorkspaceBootPayload | null {
  if (!boot?.bridge.sessionState) return boot

  return cloneBootWithBridge(boot, {
    ...boot.bridge,
    sessionState: {
      ...boot.bridge.sessionState,
      ...patch,
    },
  })
}

export function patchBootSessionName(
  boot: WorkspaceBootPayload | null,
  sessionPath: string,
  name: string,
): WorkspaceBootPayload | null {
  if (!boot) return null

  const isActiveSession = getLiveActiveSessionPath(boot) === sessionPath
  const nextBridge =
    isActiveSession && boot.bridge.sessionState
      ? {
          ...boot.bridge,
          sessionState: {
            ...boot.bridge.sessionState,
            sessionName: name,
          },
        }
      : boot.bridge

  const nextBoot = {
    ...boot,
    bridge: nextBridge,
  }

  return {
    ...nextBoot,
    resumableSessions: overlayLiveBridgeSessionState(
      nextBoot.resumableSessions.map((session) =>
        session.path === sessionPath
          ? {
              ...session,
              name,
            }
          : session,
      ),
      nextBoot,
    ),
  }
}

export function patchBootActiveSession(
  boot: WorkspaceBootPayload | null,
  sessionPath: string,
  sessionName?: string,
): WorkspaceBootPayload | null {
  if (!boot) return null

  const selectedSession = boot.resumableSessions.find((session) => session.path === sessionPath)
  const nextBridge = {
    ...boot.bridge,
    activeSessionFile: sessionPath,
    activeSessionId: selectedSession?.id ?? boot.bridge.activeSessionId,
    sessionState: boot.bridge.sessionState
      ? {
          ...boot.bridge.sessionState,
          sessionFile: sessionPath,
          sessionId: selectedSession?.id ?? boot.bridge.sessionState.sessionId,
          sessionName: sessionName ?? selectedSession?.name ?? boot.bridge.sessionState.sessionName,
        }
      : boot.bridge.sessionState,
  }

  const nextBoot = {
    ...boot,
    bridge: nextBridge,
  }

  return {
    ...nextBoot,
    resumableSessions: overlayLiveBridgeSessionState(
      nextBoot.resumableSessions.map((session) => ({
        ...session,
        isActive: session.path === sessionPath,
      })),
      nextBoot,
    ),
  }
}

export function describeSessionPath(sessionPath: string, boot: WorkspaceBootPayload | null): string {
  const knownSession = boot?.resumableSessions.find((session) => session.path === sessionPath)
  if (knownSession?.name?.trim()) return knownSession.name.trim()
  if (knownSession?.id) return knownSession.id
  return shortenPath(sessionPath)
}
