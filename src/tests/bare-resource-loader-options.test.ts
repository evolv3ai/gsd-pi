// gsd-pi — Regression test: --bare maps to the resource-loader suppression options
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
import test from 'node:test'
import assert from 'node:assert/strict'

import { bareResourceLoaderOptions } from '../resource-loader.ts'

test('--bare suppresses skills, prompt templates, themes, and CLAUDE.md/AGENTS.md context files', () => {
  // The RPC child spawned by `gsd headless --bare` builds its resource loader
  // from these options. If this mapping is dropped, --bare degrades to a
  // silent no-op (full context loaded) — worse than the startup crash it fixed.
  assert.deepEqual(bareResourceLoaderOptions(true), {
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
})

test('without --bare the options are untouched', () => {
  assert.deepEqual(bareResourceLoaderOptions(undefined), {})
  assert.deepEqual(bareResourceLoaderOptions(false), {})
})
