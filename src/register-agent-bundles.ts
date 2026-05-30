import * as agentCore from '@gsd/agent-core'
import * as agentModes from '@gsd/agent-modes'
import { registerExtensionBundledModules } from '@gsd/pi-coding-agent/core/extensions/loader.js'

let registered = false

/** Register GSD agent packages for extension virtual module resolution. */
export function registerAgentBundles(): void {
  if (registered) return
  registered = true
  registerExtensionBundledModules({
    '@gsd/agent-core': agentCore,
    '@gsd/agent-modes': agentModes,
  })
}
