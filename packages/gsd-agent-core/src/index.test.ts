import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('@gsd/agent-core', () => {
  it('exports createAgentSession factory', async () => {
    const mod = await import('./index.js')
    assert.equal(typeof mod.createAgentSession, 'function')
    assert.equal(typeof mod.AgentSession, 'function')
  })
})
