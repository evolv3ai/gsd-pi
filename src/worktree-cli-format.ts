import chalk from 'chalk'

export interface WorktreeStatusLike {
  name: string
  path: string
  branch: string
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  uncommitted: boolean
  commits: number
}

export function formatStatus(status: WorktreeStatusLike): string {
  const lines: string[] = []
  const badge = statusBadge(status)

  lines.push(`  ${chalk.bold.cyan(status.name)}${badge}`)
  lines.push(`    ${chalk.dim('branch')}  ${chalk.magenta(status.branch)}`)
  lines.push(`    ${chalk.dim('path')}    ${chalk.dim(status.path)}`)

  if (status.filesChanged > 0) {
    lines.push(formatDiffLine(status))
  }

  return lines.join('\n')
}

export function formatMultipleWorktreesPrompt(worktrees: WorktreeStatusLike[]): string {
  const countLabel = worktrees.length === 1 ? 'worktree has' : 'worktrees have'
  const lines = [chalk.yellow(`${worktrees.length} ${countLabel} unmerged changes:`), '']
  for (const wt of worktrees) {
    lines.push(formatStatus(wt), '')
  }
  lines.push(chalk.dim('Specify which one: gsd -w <name>'))
  return lines.join('\n') + '\n'
}

function statusBadge(status: WorktreeStatusLike): string {
  if (status.uncommitted) {
    return chalk.yellow(' (uncommitted)')
  }

  if (status.filesChanged > 0) {
    return chalk.cyan(' (unmerged)')
  }

  return chalk.green(' (clean)')
}

function formatDiffLine(status: WorktreeStatusLike): string {
  const fileLabel = pluralizedNoun(status.filesChanged, 'file')
  const commitLabel = pluralizedNoun(status.commits, 'commit')
  return `    ${chalk.dim('diff')}    ${status.filesChanged} ${fileLabel}, ${chalk.green(`+${status.linesAdded}`)} ${chalk.red(`-${status.linesRemoved}`)}, ${status.commits} ${commitLabel}`
}

function pluralizedNoun(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}
