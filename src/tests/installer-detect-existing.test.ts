import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  parseInstalledVersion,
  compareActions,
  detectInstalledVersion,
} from '../../scripts/install/detect-existing.js'

test('parseInstalledVersion reads direct dependency entry', () => {
  const version = parseInstalledVersion({
    dependencies: {
      '@opengsd/gsd-pi': { version: '2.14.0' },
    },
  })
  assert.equal(version, '2.14.0')
})

test('parseInstalledVersion walks nested dependency tree', () => {
  const version = parseInstalledVersion({
    dependencies: {
      foo: {
        dependencies: {
          '@opengsd/gsd-pi': { version: '2.10.1' },
        },
      },
    },
  })
  assert.equal(version, '2.10.1')
})

test('parseInstalledVersion reads pnpm list array output', () => {
  const version = parseInstalledVersion([
    {
      dependencies: {
        '@opengsd/gsd-pi': { version: '2.15.0' },
      },
    },
  ])
  assert.equal(version, '2.15.0')
})

test('compareActions returns upgrade in yes mode when installed', () => {
  assert.equal(
    compareActions({ installed: '2.12.0', yesMode: true }),
    'upgrade',
  )
})

test('compareActions returns prompt when installed and interactive', () => {
  assert.equal(
    compareActions({ installed: '2.12.0', yesMode: false }),
    'prompt',
  )
})

test('compareActions returns fresh when not installed', () => {
  assert.equal(
    compareActions({ installed: null, yesMode: false }),
    'fresh',
  )
})

test('detectInstalledVersion parses npm list wrapper output', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'gsd-npm-'))
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npmPath = join(binDir, npmBin)
  const npmListJson = '{"dependencies":{"@opengsd/gsd-pi":{"version":"2.14.0"}}}'
  const script = process.platform === 'win32'
    ? `@echo off\r\necho ${npmListJson}\r\n`
    : `#!/usr/bin/env sh\nprintf '%s\\n' '${npmListJson}'\n`
  const originalPath = process.env.PATH

  try {
    await writeFile(npmPath, script, { mode: 0o755 })
    if (process.platform !== 'win32') await chmod(npmPath, 0o755)
    process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter)

    assert.equal(await detectInstalledVersion({ packageManager: 'npm' }), '2.14.0')
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(binDir, { recursive: true, force: true })
  }
})

test('detectInstalledVersion parses pnpm list wrapper output', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'gsd-pnpm-'))
  const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const pnpmPath = join(binDir, pnpmBin)
  const pnpmListJson = '[{"dependencies":{"@opengsd/gsd-pi":{"version":"2.15.0"}}}]'
  const script = process.platform === 'win32'
    ? `@echo off\r\necho ${pnpmListJson}\r\n`
    : `#!/usr/bin/env sh\nprintf '%s\\n' '${pnpmListJson}'\n`
  const originalPath = process.env.PATH

  try {
    await writeFile(pnpmPath, script, { mode: 0o755 })
    if (process.platform !== 'win32') await chmod(pnpmPath, 0o755)
    process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter)

    assert.equal(await detectInstalledVersion({ packageManager: 'pnpm' }), '2.15.0')
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(binDir, { recursive: true, force: true })
  }
})
