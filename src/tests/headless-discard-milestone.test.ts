// Project/App: gsd-pi
// File Purpose: Headless discard argument and structured-result contracts.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  parseDiscardMilestoneArgs,
  runHeadlessDiscardMilestone,
} from '../headless-discard-milestone.ts'

describe('headless discard-milestone', () => {
  test('requires the explicit orphan-only safety flag and at least one ID', () => {
    assert.deepEqual(parseDiscardMilestoneArgs(['M001']), {
      ids: ['M001'],
      errors: ['exactly one --orphan-only flag is required'],
    })
    assert.deepEqual(parseDiscardMilestoneArgs(['--orphan-only']), {
      ids: [],
      errors: ['at least one milestone ID is required'],
    })
  })

  test('preserves all positional IDs for one atomic extension call', async () => {
    let receivedIds: readonly string[] = []
    let closeCalls = 0
    const result = await runHeadlessDiscardMilestone('/project', [
      'M001',
      'M002',
      '--orphan-only',
    ], {
      openExistingWorkflowDatabase: () => ({ ok: true, reason: 'opened-existing' }),
      closeWorkflowDatabase: () => {
        closeCalls++
        throw new Error('synthetic close failure')
      },
      discardOrphanMilestoneReservations: (_basePath, ids) => {
        receivedIds = ids
        return {
          ok: true,
          command: 'discard-milestone',
          orphanOnly: true,
          before: [{ id: 'M001' }, { id: 'M002' }],
          after: [{ id: 'M001', dbRow: false }, { id: 'M002', dbRow: false }],
        }
      },
    })

    assert.equal(result.exitCode, 0)
    assert.deepEqual(receivedIds, ['M001', 'M002'])
    assert.equal(closeCalls, 1)
    assert.equal(result.output.ok, true)
    assert.equal(result.output.before.length, 2)
    assert.equal(result.output.after.length, 2)
  })

  test('reports a structured refusal without creating a missing database', async () => {
    let discardCalls = 0
    const result = await runHeadlessDiscardMilestone('/project', ['M001', '--orphan-only'], {
      openExistingWorkflowDatabase: () => ({ ok: false, reason: 'missing-database' }),
      closeWorkflowDatabase: () => {},
      discardOrphanMilestoneReservations: () => {
        discardCalls++
        throw new Error('must not run')
      },
    })

    assert.equal(result.exitCode, 1)
    assert.equal(result.output.ok, false)
    assert.deepEqual(result.output.before, [])
    assert.deepEqual(result.output.after, [])
    assert.match(result.output.errors?.[0] ?? '', /missing-database/)
    assert.equal(discardCalls, 0)
  })
})
