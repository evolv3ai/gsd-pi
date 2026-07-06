// Project/App Name: gsd-pi + DB-authoritative milestone readiness for `--auto` chaining
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// The `new-milestone --auto` chain decision historically hinged on regex-matching
// a specific notify string ("Milestone <id> ready."), which is only emitted on one
// of several planning success paths. Any run that finishes planning through a
// different branch — or takes an early-return handoff path — completes successfully
// yet never chains into execution (issue #1295).
//
// This module makes the decision authoritative by querying the workflow DB directly:
// a milestone is executable when there is an active (non-terminal) milestone that has
// at least one slice. The notify-text signal remains a fast path; this is the
// deciding fallback.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  closeWorkflowDatabase,
  openExistingWorkflowDatabase,
} from './resources/extensions/gsd/db-workspace.js'
import type { MilestoneRow } from './resources/extensions/gsd/db-milestone-artifact-rows.js'
import {
  getAllMilestones,
  getMilestoneSlices,
  getSlicesByMilestoneIds,
} from './resources/extensions/gsd/gsd-db.js'
import { classifyMilestoneReadiness } from './resources/extensions/gsd/milestone-readiness.js'
import {
  buildMilestoneFileName,
  resolveFile,
  resolveMilestonePath,
} from './resources/extensions/gsd/paths.js'
import { isClosedStatus } from './resources/extensions/gsd/status-guards.js'

function milestoneArtifactExistsInResolvedDir(
  milestoneDir: string | null,
  milestoneId: string,
  suffix: string,
): boolean {
  if (!milestoneDir) return false
  const flatPath = join(milestoneDir, buildMilestoneFileName(milestoneId, suffix))
  return existsSync(flatPath) || resolveFile(milestoneDir, milestoneId, suffix) !== null
}

/**
 * Mirror `buildRegistryAndFindActive` active-milestone selection: defer queued-shell
 * milestones (queued, no context, zero slices) so a later planned milestone is
 * treated as active instead of an older orphan shell (#1295).
 */
function findDerivedActiveMilestone(basePath: string): MilestoneRow | null {
  const milestones = getAllMilestones()
  const completeMilestoneIds = new Set<string>()
  const parkedMilestoneIds = new Set<string>()

  for (const m of milestones) {
    if (m.status === 'parked') {
      parkedMilestoneIds.add(m.id)
      continue
    }
    if (isClosedStatus(m.status)) {
      completeMilestoneIds.add(m.id)
    }
  }

  const activeMilestoneIds = milestones
    .filter((m) => !parkedMilestoneIds.has(m.id))
    .map((m) => m.id)
  const slicesByMilestone = getSlicesByMilestoneIds(activeMilestoneIds)

  let firstDeferredQueuedShell: MilestoneRow | null = null
  let activeMilestoneFound = false

  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) continue
    if (completeMilestoneIds.has(m.id)) continue

    const slices = slicesByMilestone.get(m.id) ?? []
    const milestoneDir = resolveMilestonePath(basePath, m.id)
    const hasContext = milestoneArtifactExistsInResolvedDir(milestoneDir, m.id, 'CONTEXT')
    const hasDraftContext = !hasContext && milestoneArtifactExistsInResolvedDir(milestoneDir, m.id, 'CONTEXT-DRAFT')
    const readiness = classifyMilestoneReadiness({
      status: m.status,
      hasContext,
      hasDraftContext,
      sliceCount: slices.length,
    })

    if (!activeMilestoneFound) {
      const depsUnmet = m.depends_on.some((dep) => !completeMilestoneIds.has(dep))
      if (depsUnmet) continue

      if (readiness.kind === 'queued-shell') {
        if (!firstDeferredQueuedShell) firstDeferredQueuedShell = m
        continue
      }

      activeMilestoneFound = true
      return m
    }
  }

  return firstDeferredQueuedShell
}

/**
 * Return true when the workflow DB for `basePath` holds an executable milestone —
 * an active (non-terminal) milestone with at least one slice — meaning auto-mode
 * has real work to pick up.
 *
 * Never throws: returns false when the DB is missing or cannot be opened/queried,
 * so the caller can fall back to the notify-text signal.
 */
export function isMilestoneExecutableInDb(basePath: string): boolean {
  const opened = openExistingWorkflowDatabase(basePath)
  if (!opened.ok) return false
  try {
    const active = findDerivedActiveMilestone(basePath)
    return active != null && getMilestoneSlices(active.id).length > 0
  } catch {
    return false
  } finally {
    closeWorkflowDatabase()
  }
}
