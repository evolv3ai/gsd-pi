/**
 * Regression tests for #1293 — `--print` mode must not discard a
 * `process.exitCode` set by a slash command or extension handler.
 *
 * The print-mode branch in src/cli.ts used to call `process.exit(0)`
 * unconditionally, forcing a success exit even when a handler had signalled
 * failure (or a custom verdict) via `process.exitCode`. It now resolves the
 * final code through `resolvePrintModeExitCode`, which honors a set code and
 * defaults to 0.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolvePrintModeExitCode } from '../print-mode-exit.js'

test('defaults to 0 when no exit code was set (#1293)', () => {
  assert.equal(resolvePrintModeExitCode(undefined), 0)
})

test('preserves an explicit success code of 0', () => {
  assert.equal(resolvePrintModeExitCode(0), 0)
})

test('propagates a non-zero exit code set by a handler (#1293)', () => {
  assert.equal(resolvePrintModeExitCode(1), 1)
  assert.equal(resolvePrintModeExitCode(2), 2)
  assert.equal(resolvePrintModeExitCode(42), 42)
})
