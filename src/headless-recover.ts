// gsd-pi — Headless Recover entrypoint
/**
 * Headless Recover — `gsd headless recover`
 *
 * Non-interactive parallel of the `/gsd recover` slash command. Applies one
 * sealed markdown Preview through the verified Import Application boundary.
 *
 * Output: `gsd-recover: recovered <N>M/<N>S/<N>T hierarchy\n` to stderr on
 * success — same marker emitted by handleRecover (commands-maintenance.ts)
 * so callers can distinguish the success path from a silent no-op.
 *
 * Exit codes:
 *   0 — recovery succeeded
 *   1 — setup, verified-backup rehearsal, or migration failed
 */

import { createJiti } from '@mariozechner/jiti'
import { fileURLToPath } from 'node:url'
import { resolveGsdAgentExtensionsDir, shouldUseAgentExtensionsDir } from './headless-query.js'
import { resolveBundledGsdExtensionModule } from './bundled-resource-path.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false })

const agentExtensionsDir = resolveGsdAgentExtensionsDir()
const { useAgentDir } = shouldUseAgentExtensionsDir({ env: process.env })
const gsdExtensionPath = (...segments: string[]) =>
  useAgentDir
    ? resolveAgentExtensionModule(agentExtensionsDir, segments)
    : resolveBundledGsdExtensionModule(import.meta.url, segments.join('/'))

function resolveAgentExtensionModule(agentDir: string, segments: string[]): string {
  const requested = join(agentDir, ...segments)
  if (existsSync(requested)) return requested
  if (segments.length === 1 && segments[0].endsWith('.ts')) {
    const jsPath = join(agentDir, segments[0].replace(/\.ts$/, '.js'))
    if (existsSync(jsPath)) return jsPath
  }
  return requested
}

async function loadExtensionModules() {
  const dbModule = await jiti.import(gsdExtensionPath('gsd-db.ts'), {}) as any
  const dynamicToolsModule = await jiti.import(gsdExtensionPath('bootstrap/dynamic-tools.ts'), {}) as any
  const workspaceModule = await jiti.import(gsdExtensionPath('db-workspace.ts'), {}) as any
  const applyVerifiedRecoverApplication = workspaceModule.applyVerifiedRecoverApplication
  if (typeof applyVerifiedRecoverApplication !== 'function') {
    throw new Error('selected GSD extensions do not support verified Import Application recovery; synchronize the extension bundle')
  }
  return {
    ensureDbOpen: dynamicToolsModule.ensureDbOpen as (basePath: string) => Promise<boolean>,
    isDbAvailable: dbModule.isDbAvailable as () => boolean,
    applyVerifiedRecoverApplication: applyVerifiedRecoverApplication as ApplyVerifiedRecoverApplication,
  }
}

export interface RecoverResult {
  exitCode: number
}

interface VerifiedRecoverApplicationResult {
  backup: { backup_ref: string }
  counts: { milestones: number; slices: number; tasks: number }
}

type ApplyVerifiedRecoverApplication = (
  basePath: string,
) => VerifiedRecoverApplicationResult | Promise<VerifiedRecoverApplicationResult>

export async function handleRecover(
  basePath: string,
): Promise<RecoverResult> {
  const gsdDir = join(basePath, '.gsd')
  if (!existsSync(gsdDir)) {
    process.stderr.write(`[headless] recover: no .gsd/ directory at ${basePath}\n`)
    return { exitCode: 1 }
  }

  let modules: Awaited<ReturnType<typeof loadExtensionModules>>
  try {
    modules = await loadExtensionModules()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[headless] recover: failed to load extension modules: ${msg}\n`)
    return { exitCode: 1 }
  }

  const opened = await modules.ensureDbOpen(basePath)
  if (!opened || !modules.isDbAvailable()) {
    process.stderr.write(`[headless] recover: failed to open or create the GSD database at ${basePath}\n`)
    return { exitCode: 1 }
  }

  let application: VerifiedRecoverApplicationResult
  try {
    application = await modules.applyVerifiedRecoverApplication(basePath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[headless] recover failed: ${msg}\n`)
    return { exitCode: 1 }
  }

  process.stderr.write(
    `[headless] recover: verified backup and restore rehearsal completed at ${application.backup.backup_ref}\n`,
  )

  const { counts } = application
  process.stderr.write(
    `gsd-recover: recovered ${counts.milestones}M/${counts.slices}S/${counts.tasks}T hierarchy\n`,
  )
  return { exitCode: 0 }
}
