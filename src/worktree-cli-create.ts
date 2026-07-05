import chalk from 'chalk'
import { enterWorktreeSession, type WorktreeSessionRuntime } from './worktree-cli-session.js'

export interface WorktreeCreateDependencies {
  createWorktree: (basePath: string, name: string) => { path: string; branch: string }
  runWorktreePostCreateHook: (basePath: string, wtPath: string) => string | null
}

export type WorktreeCreateRuntime = WorktreeSessionRuntime

export function createAndEnterWorktree(
  deps: WorktreeCreateDependencies,
  basePath: string,
  name: string,
  runtime?: WorktreeCreateRuntime,
): void {
  const info = deps.createWorktree(basePath, name)
  const hookError = deps.runWorktreePostCreateHook(basePath, info.path)
  if (hookError) {
    const writeStderr = runtime?.writeStderr ?? ((message: string) => process.stderr.write(message))
    writeStderr(chalk.yellow(`[gsd] ${hookError}\n`))
  }

  enterWorktreeSession({ name, path: info.path, branch: info.branch }, basePath, 'Created', runtime)
}
