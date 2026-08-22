import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import type { HeadlessJsonResult } from './headless-types.js'

export interface QuickTaskMetadata {
  task: NonNullable<HeadlessJsonResult['task']>
  branch: string
  artifact: string
}

export interface QuickTaskGitState {
  head?: string
  worktreeStatus?: string
}

export interface QuickTaskResultDetails {
  task: NonNullable<HeadlessJsonResult['task']>
  branch: string
  artifacts: string[]
  commits: string[]
}

export interface CollectedQuickTaskResult {
  ok: boolean
  details: QuickTaskResultDetails
  error?: string
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

export function captureQuickTaskGitState(cwd: string): QuickTaskGitState {
  return {
    head: runGit(cwd, ['rev-parse', 'HEAD']) || undefined,
    worktreeStatus: runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
  }
}

export function parseQuickTaskNotification(message: string): QuickTaskMetadata | undefined {
  const match = message.match(/^Quick task (\d+): ([\s\S]+)\nDirectory: ([^\n]+)\nBranch: ([^\n]+)$/)
  if (!match) return undefined

  const number = Number.parseInt(match[1], 10)
  const taskDir = match[3]
  const dirName = basename(taskDir)
  const prefix = `${number}-`
  if (!Number.isSafeInteger(number) || !dirName.startsWith(prefix)) return undefined

  return {
    task: {
      number,
      description: match[2],
      slug: dirName.slice(prefix.length),
    },
    branch: match[4],
    artifact: `${taskDir}/${number}-SUMMARY.md`,
  }
}

export function collectQuickTaskResult(
  cwd: string,
  before: QuickTaskGitState,
  metadata: QuickTaskMetadata,
): CollectedQuickTaskResult {
  const head = runGit(cwd, ['rev-parse', 'HEAD'])
  let commits: string[] = []
  if (before.head && head && before.head !== head) {
    const revisionList = runGit(cwd, ['rev-list', '--reverse', `${before.head}..${head}`])
    commits = revisionList ? revisionList.split(/\r?\n/).filter(Boolean) : []
  }

  const isIsolatedQuick = metadata.branch.startsWith('gsd/quick/')
  const expectedCommitSubject = `quick(Q${metadata.task.number}): ${metadata.task.slug}`
  const headSubject = isIsolatedQuick && head
    ? runGit(cwd, ['show', '-s', '--format=%s', head])
    : undefined

  // Branch-isolated quick tasks squash to one deterministic closeout commit.
  // Report that resulting commit rather than any pre-branch dirty-state commit
  // that may also have been created after the initial snapshot.
  if (isIsolatedQuick && head && headSubject === expectedCommitSubject) {
    commits = [head]
  }

  const details: QuickTaskResultDetails = {
    task: metadata.task,
    branch: metadata.branch,
    artifacts: [metadata.artifact],
    commits,
  }

  if (!existsSync(resolve(cwd, metadata.artifact))) {
    return {
      ok: false,
      details,
      error: `Quick task ${metadata.task.number} did not produce its summary artifact: ${metadata.artifact}`,
    }
  }

  const currentBranch = runGit(cwd, ['branch', '--show-current'])
  if (isIsolatedQuick && currentBranch === metadata.branch) {
    return {
      ok: false,
      details,
      error: `Quick task ${metadata.task.number} did not return from branch ${metadata.branch}`,
    }
  }

  if (isIsolatedQuick) {
    if (headSubject !== expectedCommitSubject) {
      return {
        ok: false,
        details,
        error: `Quick task ${metadata.task.number} did not produce its merged quick-task commit`,
      }
    }
  }

  if (!isIsolatedQuick) {
    const worktreeStatus = runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (worktreeStatus !== before.worktreeStatus) {
      return {
        ok: false,
        details,
        error: `Quick task ${metadata.task.number} left repository changes uncommitted`,
      }
    }
  }

  return { ok: true, details }
}
