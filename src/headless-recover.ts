// gsd-pi — Headless Recover entrypoint
/**
 * Headless Recover — `gsd headless recover`
 *
 * Non-interactive parallel of the `/gsd recover` slash command. Clears the
 * milestones / slices / tasks tables and re-imports them from the on-disk
 * markdown projections (ROADMAP.md, PLAN.md, SUMMARY.md, …) via
 * migrateHierarchyToDb. Mutating: this is the one headless subcommand that
 * writes to the DB. Required for CI / automation flows that need to
 * reconcile DB state from markdown without launching an LLM session or a
 * TTY-bound interactive runtime.
 *
 * Output: `gsd-recover: recovered <N>M/<N>S/<N>T hierarchy\n` to stderr on
 * success — same marker emitted by handleRecover (commands-maintenance.ts)
 * so callers can distinguish the success path from a silent no-op.
 *
 * Exit codes:
 *   0 — recovery succeeded
 *   1 — `.gsd/` missing, DB could not be opened, or migration threw
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
  const stateModule = await jiti.import(gsdExtensionPath('state.ts'), {}) as any
  const dbModule = await jiti.import(gsdExtensionPath('gsd-db.ts'), {}) as any
  const importerModule = await jiti.import(gsdExtensionPath('md-importer.ts'), {}) as any
  const dynamicToolsModule = await jiti.import(gsdExtensionPath('bootstrap/dynamic-tools.ts'), {}) as any
  const migrationCheckModule = await jiti.import(gsdExtensionPath('migration-auto-check.ts'), {}) as any
  const rendererModule = await jiti.import(gsdExtensionPath('markdown-renderer.ts'), {}) as any
  type Counts = { milestones: number; slices: number; tasks: number }
  return {
    ensureDbOpen: dynamicToolsModule.ensureDbOpen as (basePath: string) => Promise<boolean>,
    isDbAvailable: dbModule.isDbAvailable as () => boolean,
    clearEngineHierarchy: dbModule.clearEngineHierarchy as () => void,
    transaction: dbModule.transaction as <T>(fn: () => T) => T,
    backupDatabaseSnapshot: dbModule.backupDatabaseSnapshot as (label: string) => string | null,
    migrateHierarchyToDb: importerModule.migrateHierarchyToDb as (basePath: string) => Counts,
    invalidateStateCache: stateModule.invalidateStateCache as () => void,
    countDbHierarchy: migrationCheckModule.countDbHierarchy as () => Counts,
    countMarkdownHierarchy: migrationCheckModule.countMarkdownHierarchy as (basePath: string) => Counts,
    recoverWouldDeleteDbRows: migrationCheckModule.recoverWouldDeleteDbRows as (basePath: string) => boolean,
    renderAllFromDb: rendererModule.renderAllFromDb as (basePath: string) =>
      Promise<{ rendered: number; skipped: number; errors: string[] }>,
  }
}

export interface RecoverResult {
  exitCode: number
}

export async function handleRecover(basePath: string): Promise<RecoverResult> {
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

  // Refuse a destructive recover that would delete authoritative DB rows the
  // markdown lacks, unless explicitly allowed. The DB is the source of truth;
  // re-projecting via rebuild is almost always what's wanted instead. The
  // check is identity-based, so it also catches equal-count divergence (DB S99
  // vs markdown S01) that a cardinality-only comparison would miss.
  const markdown = modules.countMarkdownHierarchy(basePath)
  const beforeDb = modules.countDbHierarchy()
  const dataLoss = modules.recoverWouldDeleteDbRows(basePath)
  const allowDataLoss = process.env.GSD_RECOVER_ALLOW_DATA_LOSS === '1'
  if (dataLoss && !allowDataLoss) {
    process.stderr.write(
      `[headless] recover refused: the DB (${beforeDb.milestones}M/${beforeDb.slices}S/${beforeDb.tasks}T) ` +
        `holds rows the markdown (${markdown.milestones}M/${markdown.slices}S/${markdown.tasks}T) lacks; ` +
        `recover would delete them. Set GSD_RECOVER_ALLOW_DATA_LOSS=1 to override, ` +
        `or run a DB-to-markdown rebuild instead.\n`,
    )
    return { exitCode: 1 }
  }

  // Snapshot the DB before the destructive clear so recover is reversible.
  const backupPath = modules.backupDatabaseSnapshot('pre-recover')

  let counts: { milestones: number; slices: number; tasks: number }
  try {
    counts = modules.transaction(() => {
      modules.clearEngineHierarchy()
      return modules.migrateHierarchyToDb(basePath)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[headless] recover failed: ${msg}\n`)
    return { exitCode: 1 }
  }

  modules.invalidateStateCache()

  // Re-project markdown from the freshly imported DB so disk and DB agree.
  // renderAllFromDb resolves even when individual artifacts fail, so inspect
  // its error list — a silent projection failure must surface, not pass as a
  // clean recover.
  let projectionErrors = 0
  try {
    const renderResult = await modules.renderAllFromDb(basePath)
    projectionErrors = renderResult.errors.length
    if (projectionErrors > 0) {
      process.stderr.write(
        `[headless] recover: ${projectionErrors} markdown projection(s) failed to render — markdown may be stale:\n`,
      )
      for (const e of renderResult.errors.slice(0, 10)) {
        process.stderr.write(`  - ${e}\n`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[headless] recover: re-render after import failed: ${msg}\n`)
    projectionErrors = 1
  }

  if (
    counts.milestones < markdown.milestones ||
    counts.slices < markdown.slices ||
    counts.tasks < markdown.tasks
  ) {
    process.stderr.write(
      `[headless] recover: imported fewer rows than markdown contained ` +
        `(${markdown.milestones}M/${markdown.slices}S/${markdown.tasks}T on disk); some markdown may have failed to parse\n`,
    )
  }
  if (backupPath) {
    process.stderr.write(`[headless] recover: pre-recover snapshot saved to ${backupPath}\n`)
  }

  process.stderr.write(
    `gsd-recover: recovered ${counts.milestones}M/${counts.slices}S/${counts.tasks}T hierarchy` +
      `${projectionErrors > 0 ? ` (${projectionErrors} projection error(s) — run rebuild markdown)` : ''}\n`,
  )
  return { exitCode: 0 }
}
