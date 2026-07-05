/**
 * GSD Worktree CLI — standalone subcommand and -w flag handling.
 *
 * Manages the full worktree lifecycle from the command line:
 *   gsd -w                    Create auto-named worktree, start interactive session
 *   gsd -w my-feature         Create/resume named worktree
 *   gsd worktree list         List worktrees with status
 *   gsd worktree merge [name] Squash-merge a worktree into main
 *   gsd worktree clean        Remove all merged/empty worktrees
 *   gsd worktree remove <n>   Remove a specific worktree
 *
 * On session exit (via session_shutdown event), auto-commits dirty work
 * so nothing is lost. The GSD extension reads GSD_CLI_WORKTREE to know
 * when a session was launched via -w.
 *
 * Note: Extension modules are .ts files loaded via jiti (not compiled to .js).
 * We use createJiti() here because this module is compiled by tsc but imports
 * from resources/extensions/gsd/ which are shipped as raw .ts (#1283).
 */

import chalk from 'chalk'
import { bannerLines, name as styledName, warn } from './cli-style.js'
import { createJiti } from '@mariozechner/jiti'
import { fileURLToPath } from 'node:url'
import { generateWorktreeName } from './worktree-name-gen.js'
import { resolveBundledGsdExtensionModule } from './bundled-resource-path.js'
import { getJitiWorkspaceAliases } from './jiti-workspace-aliases.js'
import { enterWorktreeSession } from './worktree-cli-session.js'
import {
  getWorktreeStatus as calculateWorktreeStatus,
  hasWorktreeChanges,
  type WorktreeDiff,
  type WorktreeStatus,
  type WorktreeStatusDependencies,
} from './worktree-cli-status.js'

const jiti = createJiti(fileURLToPath(import.meta.url), {
  interopDefault: true,
  debug: false,
  alias: getJitiWorkspaceAliases(import.meta.url),
})
const gsdExtensionPath = (...segments: string[]) =>
  resolveBundledGsdExtensionModule(import.meta.url, segments.join('/'))

// Lazily-loaded extension modules (loaded once on first use via jiti)
let _ext: ExtensionModules | null = null
let _mergeExt: MergeModules | null = null

interface ExtensionModules {
  createWorktree: (basePath: string, name: string) => { path: string; branch: string }
  listWorktrees: (basePath: string) => Array<{ name: string; path: string; branch: string }>
  removeWorktree: (basePath: string, name: string, opts?: { deleteBranch?: boolean; branch?: string }) => void
  mergeWorktreeToMain: (basePath: string, name: string, commitMessage: string, branch?: string) => void
  diffWorktreeAll: (basePath: string, name: string, branch?: string) => WorktreeDiff
  diffWorktreeNumstat: (basePath: string, name: string, branch?: string) => Array<{ added: number; removed: number }>
  worktreeBranchName: (name: string) => string
  worktreePath: (basePath: string, name: string) => string
  runWorktreePostCreateHook: (basePath: string, wtPath: string) => string | null
  nativeHasChanges: (path: string) => boolean
  nativeDetectMainBranch: (basePath: string) => string
  nativeCommitCountBetween: (basePath: string, from: string, to: string) => number
  resolveWorktreeProjectRoot: (basePath: string) => string
}

interface MergeModules {
  inferCommitType: (name: string) => string
  autoCommitCurrentBranch: (wtPath: string, reason: string, name: string) => void
}

interface WorktreeManagerModule {
  createWorktree: ExtensionModules['createWorktree']
  listWorktrees: ExtensionModules['listWorktrees']
  removeWorktree: ExtensionModules['removeWorktree']
  mergeWorktreeToMain: ExtensionModules['mergeWorktreeToMain']
  diffWorktreeAll: ExtensionModules['diffWorktreeAll']
  diffWorktreeNumstat: ExtensionModules['diffWorktreeNumstat']
  worktreeBranchName: ExtensionModules['worktreeBranchName']
  worktreePath: ExtensionModules['worktreePath']
}

interface WorktreePostCreateHookModule {
  runWorktreePostCreateHook: ExtensionModules['runWorktreePostCreateHook']
}

interface NativeGitBridgeModule {
  nativeHasChanges: ExtensionModules['nativeHasChanges']
  nativeDetectMainBranch: ExtensionModules['nativeDetectMainBranch']
  nativeCommitCountBetween: ExtensionModules['nativeCommitCountBetween']
}

interface GitServiceModule {
  inferCommitType: MergeModules['inferCommitType']
}

interface WorktreeModule {
  autoCommitCurrentBranch: MergeModules['autoCommitCurrentBranch']
}

interface WorktreeRootModule {
  resolveWorktreeProjectRoot: ExtensionModules['resolveWorktreeProjectRoot']
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logDebugFailure(scope: string, error: unknown): void {
  if (process.env.GSD_DEBUG === '1') {
    process.stderr.write(chalk.dim(`[gsd] ${scope} failed: ${toErrorMessage(error)}\n`))
  }
}

async function loadExtensionModules(): Promise<ExtensionModules> {
  if (_ext) return _ext
  const [wtMgr, hook, gitBridge, wtRoot] = await Promise.all([
    jiti.import(gsdExtensionPath('worktree-manager.ts'), {}) as Promise<WorktreeManagerModule>,
    jiti.import(gsdExtensionPath('worktree-post-create-hook.ts'), {}) as Promise<WorktreePostCreateHookModule>,
    jiti.import(gsdExtensionPath('native-git-bridge.ts'), {}) as Promise<NativeGitBridgeModule>,
    jiti.import(gsdExtensionPath('worktree-root.ts'), {}) as Promise<WorktreeRootModule>,
  ])
  _ext = {
    createWorktree: wtMgr.createWorktree,
    listWorktrees: wtMgr.listWorktrees,
    removeWorktree: wtMgr.removeWorktree,
    mergeWorktreeToMain: wtMgr.mergeWorktreeToMain,
    diffWorktreeAll: wtMgr.diffWorktreeAll,
    diffWorktreeNumstat: wtMgr.diffWorktreeNumstat,
    worktreeBranchName: wtMgr.worktreeBranchName,
    worktreePath: wtMgr.worktreePath,
    runWorktreePostCreateHook: hook.runWorktreePostCreateHook,
    nativeHasChanges: gitBridge.nativeHasChanges,
    nativeDetectMainBranch: gitBridge.nativeDetectMainBranch,
    nativeCommitCountBetween: gitBridge.nativeCommitCountBetween,
    resolveWorktreeProjectRoot: wtRoot.resolveWorktreeProjectRoot,
  }
  return _ext
}

async function loadMergeModules(): Promise<MergeModules> {
  if (_mergeExt) return _mergeExt
  const [gitSvc, wt] = await Promise.all([
    jiti.import(gsdExtensionPath('git-service.ts'), {}) as Promise<GitServiceModule>,
    jiti.import(gsdExtensionPath('worktree.ts'), {}) as Promise<WorktreeModule>,
  ])
  _mergeExt = {
    inferCommitType: gitSvc.inferCommitType,
    autoCommitCurrentBranch: wt.autoCommitCurrentBranch,
  }
  return _mergeExt
}

// ─── Status Helpers ─────────────────────────────────────────────────────────

function getWorktreeStatus(ext: ExtensionModules, basePath: string, name: string, wtPath: string, branch: string): WorktreeStatus {
  return calculateWorktreeStatus(worktreeStatusDependencies(ext), basePath, name, wtPath, branch)
}

function worktreeStatusDependencies(ext: ExtensionModules): WorktreeStatusDependencies {
  return {
    diffWorktreeAll: ext.diffWorktreeAll,
    diffWorktreeNumstat: ext.diffWorktreeNumstat,
    nativeHasChanges: ext.nativeHasChanges,
    nativeDetectMainBranch: ext.nativeDetectMainBranch,
    nativeCommitCountBetween: ext.nativeCommitCountBetween,
    onDebugFailure: logDebugFailure,
  }
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatStatus(s: WorktreeStatus): string {
  const lines: string[] = []
  const badge = s.uncommitted
    ? chalk.yellow(' (uncommitted)')
    : s.filesChanged > 0
      ? chalk.cyan(' (unmerged)')
      : chalk.green(' (clean)')

  lines.push(`  ${chalk.bold.cyan(s.name)}${badge}`)
  lines.push(`    ${chalk.dim('branch')}  ${chalk.magenta(s.branch)}`)
  lines.push(`    ${chalk.dim('path')}    ${chalk.dim(s.path)}`)

  if (s.filesChanged > 0) {
    lines.push(`    ${chalk.dim('diff')}    ${s.filesChanged} files, ${chalk.green(`+${s.linesAdded}`)} ${chalk.red(`-${s.linesRemoved}`)}, ${s.commits} commit${s.commits === 1 ? '' : 's'}`)
  }

  return lines.join('\n')
}

// ─── Subcommand: list ───────────────────────────────────────────────────────

async function handleList(basePath: string): Promise<void> {
  const ext = await loadExtensionModules()
  basePath = ext.resolveWorktreeProjectRoot(basePath)
  const worktrees = ext.listWorktrees(basePath)

  if (worktrees.length === 0) {
    process.stderr.write(chalk.dim('No worktrees. Create one with: gsd -w <name>\n'))
    return
  }

  process.stderr.write(chalk.bold('\nWorktrees\n\n'))
  for (const wt of worktrees) {
    const status = getWorktreeStatus(ext, basePath, wt.name, wt.path, wt.branch)
    process.stderr.write(formatStatus(status) + '\n\n')
  }
}

// ─── Subcommand: merge ──────────────────────────────────────────────────────

async function handleMerge(basePath: string, args: string[]): Promise<void> {
  const ext = await loadExtensionModules()
  basePath = ext.resolveWorktreeProjectRoot(basePath)
  const name = args[0]
  if (!name) {
    // If only one worktree exists, merge it
    const worktrees = ext.listWorktrees(basePath)
    if (worktrees.length === 1) {
      await doMerge(ext, basePath, worktrees[0].name)
      return
    }
    process.stderr.write(chalk.red('Usage: gsd worktree merge <name>\n'))
    process.stderr.write(chalk.dim('Run gsd worktree list to see worktrees.\n'))
    process.exit(1)
  }
  await doMerge(ext, basePath, name)
}

async function doMerge(ext: ExtensionModules, basePath: string, name: string): Promise<void> {
  const mergeExt = await loadMergeModules()
  const worktrees = ext.listWorktrees(basePath)
  const wt = worktrees.find(w => w.name === name)
  if (!wt) {
    process.stderr.write(chalk.red(`Worktree "${name}" not found.\n`))
    process.exit(1)
  }

  const status = getWorktreeStatus(ext, basePath, name, wt.path, wt.branch)
  if (status.filesChanged === 0 && !status.uncommitted) {
    process.stderr.write(chalk.dim(`Worktree "${name}" has no changes to merge.\n`))
    // Clean up empty worktree
    ext.removeWorktree(basePath, name, { deleteBranch: true, branch: wt.branch })
    process.stderr.write(chalk.green(`Removed empty worktree ${chalk.bold(name)}.\n`))
    return
  }

  // Auto-commit dirty work before merge
  if (status.uncommitted) {
    try {
      mergeExt.autoCommitCurrentBranch(wt.path, 'worktree-merge', name)
      process.stderr.write(chalk.dim('  Auto-committed dirty work before merge.\n'))
    } catch (error) {
      process.stderr.write(chalk.yellow(`  Auto-commit before merge failed: ${toErrorMessage(error)}\n`))
    }
  }

  const commitType = mergeExt.inferCommitType(name)
  const commitMessage = `${commitType}: merge worktree ${name}\n\nGSD-Worktree: ${name}`

  process.stderr.write(`\nMerging ${chalk.bold.cyan(name)} → ${chalk.magenta(ext.nativeDetectMainBranch(basePath))}\n`)
  process.stderr.write(chalk.dim(`  ${status.filesChanged} files, ${chalk.green(`+${status.linesAdded}`)} ${chalk.red(`-${status.linesRemoved}`)}\n\n`))

  try {
    ext.mergeWorktreeToMain(basePath, name, commitMessage, wt.branch)
    ext.removeWorktree(basePath, name, { deleteBranch: true, branch: wt.branch })
    process.stderr.write(chalk.green(`✓ Merged and cleaned up ${chalk.bold(name)}\n`))
    process.stderr.write(chalk.dim(`  commit: ${commitMessage}\n`))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(chalk.red(`✗ Merge failed: ${msg}\n`))
    process.stderr.write(chalk.dim('  Resolve conflicts manually, then run gsd worktree merge again.\n'))
    process.exit(1)
  }
}

// ─── Subcommand: clean ──────────────────────────────────────────────────────

async function handleClean(basePath: string): Promise<void> {
  const ext = await loadExtensionModules()
  basePath = ext.resolveWorktreeProjectRoot(basePath)
  const worktrees = ext.listWorktrees(basePath)
  if (worktrees.length === 0) {
    process.stderr.write(chalk.dim('No worktrees to clean.\n'))
    return
  }

  let cleaned = 0
  for (const wt of worktrees) {
    const status = getWorktreeStatus(ext, basePath, wt.name, wt.path, wt.branch)
    if (status.filesChanged === 0 && !status.uncommitted) {
      try {
        ext.removeWorktree(basePath, wt.name, { deleteBranch: true, branch: wt.branch })
        process.stderr.write(chalk.green(`  ✓ Removed ${chalk.bold(wt.name)} (clean)\n`))
        cleaned++
      } catch (error) {
        process.stderr.write(chalk.yellow(`  ✗ Failed to remove ${wt.name}: ${toErrorMessage(error)}\n`))
      }
    } else {
      process.stderr.write(chalk.dim(`  ─ Kept ${chalk.bold(wt.name)} (${status.filesChanged} changed files)\n`))
    }
  }

  process.stderr.write(chalk.dim(`\nCleaned ${cleaned} worktree${cleaned === 1 ? '' : 's'}.\n`))
}

// ─── Subcommand: remove ─────────────────────────────────────────────────────

async function handleRemove(basePath: string, args: string[]): Promise<void> {
  const ext = await loadExtensionModules()
  basePath = ext.resolveWorktreeProjectRoot(basePath)
  const name = args[0]
  if (!name) {
    process.stderr.write(chalk.red('Usage: gsd worktree remove <name>\n'))
    process.exit(1)
  }

  const worktrees = ext.listWorktrees(basePath)
  const wt = worktrees.find(w => w.name === name)
  if (!wt) {
    process.stderr.write(chalk.red(`Worktree "${name}" not found.\n`))
    process.exit(1)
  }

  const status = getWorktreeStatus(ext, basePath, name, wt.path, wt.branch)
  if (status.filesChanged > 0 || status.uncommitted) {
    process.stderr.write(chalk.yellow(`⚠ Worktree "${name}" has unmerged changes (${status.filesChanged} files).\n`))
    process.stderr.write(chalk.yellow('  Use --force to remove anyway, or merge first: gsd worktree merge ' + name + '\n'))
    if (!process.argv.includes('--force')) {
      process.exit(1)
    }
  }

  ext.removeWorktree(basePath, name, { deleteBranch: true, branch: wt.branch })
  process.stderr.write(chalk.green(`✓ Removed worktree ${chalk.bold(name)}\n`))
}

// ─── Subcommand: status (default when no args) ─────────────────────────────

async function handleStatusBanner(basePath: string): Promise<void> {
  const ext = await loadExtensionModules()
  basePath = ext.resolveWorktreeProjectRoot(basePath)
  const worktrees = ext.listWorktrees(basePath)
  if (worktrees.length === 0) return

  const withChanges = worktrees.filter(wt => {
    try {
      return hasWorktreeChanges(worktreeStatusDependencies(ext), basePath, wt.name, wt.branch)
    } catch (error) {
      logDebugFailure(`status scan for ${wt.name}`, error)
      return false
    }
  })

  if (withChanges.length === 0) return

  const names = withChanges.map(w => styledName(w.name)).join(', ')
  process.stderr.write(
    bannerLines(
      warn(`${withChanges.length} worktree${withChanges.length === 1 ? '' : 's'} with unmerged changes: `) + names,
      'Resume: gsd -w <name>  |  Merge: gsd worktree merge <name>  |  List: gsd worktree list',
    ),
  )
}

// ─── -w flag: create/resume worktree for interactive session ────────────────

async function handleWorktreeFlag(worktreeFlag: boolean | string): Promise<void> {
  const ext = await loadExtensionModules()
  const basePath = ext.resolveWorktreeProjectRoot(process.cwd())

  // gsd -w (no name) — resume most recent worktree with changes, or create new
  if (worktreeFlag === true) {
    const existing = ext.listWorktrees(basePath)
    const withChanges = existing.filter(wt => {
      try {
        return hasWorktreeChanges(worktreeStatusDependencies(ext), basePath, wt.name, wt.branch)
      } catch (error) {
        logDebugFailure(`worktree -w scan for ${wt.name}`, error)
        return false
      }
    })

    if (withChanges.length === 1) {
      // Single active worktree — resume it
      const wt = withChanges[0]
      enterWorktreeSession(wt, basePath, 'Resumed')
      return
    }

    if (withChanges.length > 1) {
      // Multiple active worktrees — show them and ask user to pick
      process.stderr.write(chalk.yellow(`${withChanges.length} worktrees have unmerged changes:\n\n`))
      for (const wt of withChanges) {
        const status = getWorktreeStatus(ext, basePath, wt.name, wt.path, wt.branch)
        process.stderr.write(formatStatus(status) + '\n\n')
      }
      process.stderr.write(chalk.dim('Specify which one: gsd -w <name>\n'))
      process.exit(0)
    }

    // No active worktrees — create a new one
    const name = generateWorktreeName()
    await createAndEnter(ext, basePath, name)
    return
  }

  // gsd -w <name> — create or resume named worktree
  const name = worktreeFlag as string
  const existing = ext.listWorktrees(basePath)
  const found = existing.find(wt => wt.name === name)

  if (found) {
    enterWorktreeSession(found, basePath, 'Resumed')
  } else {
    await createAndEnter(ext, basePath, name)
  }
}

async function createAndEnter(ext: ExtensionModules, basePath: string, name: string): Promise<void> {
  try {
    const info = ext.createWorktree(basePath, name)

    const hookError = ext.runWorktreePostCreateHook(basePath, info.path)
    if (hookError) {
      process.stderr.write(chalk.yellow(`[gsd] ${hookError}\n`))
    }

    enterWorktreeSession({ name, path: info.path, branch: info.branch }, basePath, 'Created')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(chalk.red(`[gsd] Failed to create worktree: ${msg}\n`))
    process.exit(1)
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  handleList,
  handleMerge,
  handleClean,
  handleRemove,
  handleStatusBanner,
  handleWorktreeFlag,
  getWorktreeStatus,
}
