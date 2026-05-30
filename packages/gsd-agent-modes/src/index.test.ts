import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('@gsd/agent-modes', () => {
  it('exports main entry and run modes', async () => {
    const mod = await import('./index.js')
    assert.equal(typeof mod.main, 'function')
    assert.equal(typeof mod.runRpcMode, 'function')
    assert.equal(typeof mod.runPrintMode, 'function')
  })
})
