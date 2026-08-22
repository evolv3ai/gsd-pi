import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  captureQuickTaskGitState,
  collectQuickTaskResult,
  parseQuickTaskNotification,
} from '../headless-quick-result.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('parseQuickTaskNotification extracts task, branch, and artifact metadata', () => {
  assert.deepEqual(
    parseQuickTaskNotification(
      'Quick task 12: fix the login button\n' +
      'Directory: .gsd/quick/12-fix-the-login-button\n' +
      'Branch: gsd/quick/12-fix-the-login-button',
    ),
    {
      task: { number: 12, description: 'fix the login button', slug: 'fix-the-login-button' },
      branch: 'gsd/quick/12-fix-the-login-button',
      artifact: '.gsd/quick/12-fix-the-login-button/12-SUMMARY.md',
    },
  )
})

test('collectQuickTaskResult reports the resulting commits and artifact', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gsd-headless-quick-result-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'chore: initial')

  const before = captureQuickTaskGitState(repo)
  const artifact = '.gsd/quick/1-fix-typo/1-SUMMARY.md'
  mkdirSync(join(repo, '.gsd', 'quick', '1-fix-typo'), { recursive: true })
  writeFileSync(join(repo, artifact), '# Summary\n')
  writeFileSync(join(repo, 'fix.txt'), 'fixed\n')
  git(repo, 'add', '.gsd/quick/1-fix-typo/1-SUMMARY.md', 'fix.txt')
  git(repo, 'commit', '-m', 'quick(Q1): fix-typo')

  const result = collectQuickTaskResult(repo, before, {
    task: { number: 1, description: 'fix typo', slug: 'fix-typo' },
    branch: 'gsd/quick/1-fix-typo',
    artifact,
  })

  assert.equal(result.ok, true)
  assert.equal(result.details.task.number, 1)
  assert.equal(result.details.branch, 'gsd/quick/1-fix-typo')
  assert.deepEqual(result.details.artifacts, [artifact])
  assert.deepEqual(result.details.commits, [git(repo, 'rev-parse', 'HEAD')])
})

test('collectQuickTaskResult fails when the summary artifact is missing', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gsd-headless-quick-missing-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'chore: initial')

  const result = collectQuickTaskResult(repo, captureQuickTaskGitState(repo), {
    task: { number: 1, description: 'fix typo', slug: 'fix-typo' },
    branch: 'gsd/quick/1-fix-typo',
    artifact: '.gsd/quick/1-fix-typo/1-SUMMARY.md',
  })

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /did not produce its summary artifact/)
})

test('collectQuickTaskResult fails when an isolated quick branch was not merged', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gsd-headless-quick-unmerged-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'chore: initial')

  const artifact = '.gsd/quick/1-fix-typo/1-SUMMARY.md'
  mkdirSync(join(repo, '.gsd', 'quick', '1-fix-typo'), { recursive: true })
  writeFileSync(join(repo, artifact), '# Summary\n')
  const result = collectQuickTaskResult(repo, captureQuickTaskGitState(repo), {
    task: { number: 1, description: 'fix typo', slug: 'fix-typo' },
    branch: 'gsd/quick/1-fix-typo',
    artifact,
  })

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /did not produce its merged quick-task commit/)
})

test('collectQuickTaskResult fails when branchless execution leaves new changes uncommitted', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'gsd-headless-quick-dirty-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  writeFileSync(join(repo, '.gitignore'), '.gsd/\n')
  git(repo, 'add', 'README.md', '.gitignore')
  git(repo, 'commit', '-m', 'chore: initial')

  const before = captureQuickTaskGitState(repo)
  const artifact = '.gsd/quick/1-fix-typo/1-SUMMARY.md'
  mkdirSync(join(repo, '.gsd', 'quick', '1-fix-typo'), { recursive: true })
  writeFileSync(join(repo, artifact), '# Summary\n')
  writeFileSync(join(repo, 'committed.txt'), 'committed\n')
  git(repo, 'add', 'committed.txt')
  git(repo, 'commit', '-m', 'fix: partial quick task')
  writeFileSync(join(repo, 'fix.txt'), 'not committed\n')
  const result = collectQuickTaskResult(repo, before, {
    task: { number: 1, description: 'fix typo', slug: 'fix-typo' },
    branch: 'main',
    artifact,
  })

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /left repository changes uncommitted/)
})
