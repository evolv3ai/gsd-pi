import chalk from 'chalk'

export type WorktreeSessionVerb = 'Created' | 'Resumed'

export interface WorktreeSessionInfo {
  name: string
  path: string
  branch: string
}

export interface WorktreeSessionRuntime {
  env: Record<string, string | undefined>
  chdir: (path: string) => void
  writeStderr: (message: string) => void
}

export function formatWorktreeSessionMessage(
  info: WorktreeSessionInfo,
  verb: WorktreeSessionVerb,
): string {
  return [
    chalk.green(`✓ ${verb} worktree ${chalk.bold(info.name)}`),
    chalk.dim(`  path   ${info.path}`),
    chalk.dim(`  branch ${info.branch}`),
  ].join('\n') + '\n\n'
}

export function enterWorktreeSession(
  info: WorktreeSessionInfo,
  basePath: string,
  verb: WorktreeSessionVerb,
  runtime: WorktreeSessionRuntime = {
    env: process.env,
    chdir: process.chdir,
    writeStderr: (message) => process.stderr.write(message),
  },
): void {
  runtime.chdir(info.path)
  runtime.env.GSD_CLI_WORKTREE = info.name
  runtime.env.GSD_CLI_WORKTREE_BASE = basePath
  runtime.writeStderr(formatWorktreeSessionMessage(info, verb))
}
