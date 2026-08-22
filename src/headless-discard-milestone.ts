/**
 * Headless orphan milestone discard — `gsd headless discard-milestone`.
 *
 * This path opens only the existing canonical database and invokes the
 * selective orphan preflight directly. It deliberately does not start an RPC
 * session or run extension bootstrap/reconciliation.
 */

import { createJiti } from '@mariozechner/jiti'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { resolveBundledGsdExtensionModule } from './bundled-resource-path.js'
import { resolveGsdAgentExtensionsDir, shouldUseAgentExtensionsDir } from './headless-query.js'

const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false })
const agentExtensionsDir = resolveGsdAgentExtensionsDir()
const { useAgentDir } = shouldUseAgentExtensionsDir({ env: process.env })

function extensionModule(...segments: string[]): string {
  if (!useAgentDir) return resolveBundledGsdExtensionModule(import.meta.url, segments.join('/'))
  const requested = join(agentExtensionsDir, ...segments)
  if (existsSync(requested)) return requested
  const jsPath = requested.replace(/\.ts$/, '.js')
  return existsSync(jsPath) ? jsPath : requested
}

interface DiscardOutput {
  ok: boolean
  command: 'discard-milestone'
  orphanOnly: true
  before: unknown[]
  after: unknown[]
  errors?: string[]
}

interface DiscardModules {
  openExistingWorkflowDatabase(basePath: string): { ok: boolean; reason: string; error?: Error }
  closeWorkflowDatabase(): void
  discardOrphanMilestoneReservations(basePath: string, ids: readonly string[]): DiscardOutput
}

async function loadModules(): Promise<DiscardModules> {
  const workspace = await jiti.import(extensionModule('db-workspace.ts'), {}) as any
  const discard = await jiti.import(extensionModule('orphan-milestone-discard.ts'), {}) as any
  return {
    openExistingWorkflowDatabase: workspace.openExistingWorkflowDatabase,
    closeWorkflowDatabase: workspace.closeWorkflowDatabase,
    discardOrphanMilestoneReservations: discard.discardOrphanMilestoneReservations,
  }
}

export interface HeadlessDiscardResult {
  exitCode: number
  output: DiscardOutput
}

function refusal(errors: string[]): HeadlessDiscardResult {
  return {
    exitCode: 1,
    output: { ok: false, command: 'discard-milestone', orphanOnly: true, before: [], after: [], errors },
  }
}

export function parseDiscardMilestoneArgs(args: readonly string[]): { ids: string[]; errors: string[] } {
  const errors: string[] = []
  const orphanOnlyCount = args.filter((arg) => arg === '--orphan-only').length
  if (orphanOnlyCount !== 1) errors.push('exactly one --orphan-only flag is required')
  const unknownFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--orphan-only')
  if (unknownFlags.length > 0) errors.push(`unknown flags: ${unknownFlags.join(', ')}`)
  const ids = args.filter((arg) => !arg.startsWith('--'))
  if (ids.length === 0) errors.push('at least one milestone ID is required')
  return { ids, errors }
}

export async function runHeadlessDiscardMilestone(
  basePath: string,
  args: readonly string[],
  modules: DiscardModules,
): Promise<HeadlessDiscardResult> {
  const parsed = parseDiscardMilestoneArgs(args)
  if (parsed.errors.length > 0) return refusal(parsed.errors)

  let opened = false
  try {
    const openResult = modules.openExistingWorkflowDatabase(basePath)
    if (!openResult.ok) {
      return refusal([
        openResult.reason === 'schema-too-new' && openResult.error
          ? openResult.error.message
          : `canonical database unavailable: ${openResult.reason}`,
      ])
    }
    opened = true
    const output = modules.discardOrphanMilestoneReservations(basePath, parsed.ids)
    return { exitCode: output.ok ? 0 : 1, output }
  } catch (error) {
    return refusal([error instanceof Error ? error.message : String(error)])
  } finally {
    if (opened) {
      try {
        modules.closeWorkflowDatabase()
      } catch {
        // The operation result is authoritative; a close failure must not
        // replace a committed deletion and its before/after snapshots.
      }
    }
  }
}

export async function handleDiscardMilestone(basePath: string, args: readonly string[]): Promise<HeadlessDiscardResult> {
  let result: HeadlessDiscardResult
  try {
    result = await runHeadlessDiscardMilestone(basePath, args, await loadModules())
  } catch (error) {
    result = refusal([`failed to load discard modules: ${error instanceof Error ? error.message : String(error)}`])
  }
  process.stdout.write(`${JSON.stringify(result.output)}\n`)
  return result
}
