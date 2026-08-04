#!/usr/bin/env node
/**
 * One-time migration helper: move GSD code from pi-coding-agent into
 * gsd-agent-core and gsd-agent-modes per ADR-010.
 */
'use strict'

const { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const ROOT = join(__dirname, '..')
const PI = join(ROOT, 'packages/pi-coding-agent/src')
const CORE = join(ROOT, 'packages/gsd-agent-core/src')
const MODES = join(ROOT, 'packages/gsd-agent-modes/src')

function mv(src, dest) {
  mkdirSync(join(dest, '..'), { recursive: true })
  if (!existsSync(src)) {
    console.warn('skip missing', src)
    return
  }
  renameSync(src, dest)
  console.log('mv', src.replace(ROOT + '/', ''), '->', dest.replace(ROOT + '/', ''))
}

function moveAgentCore() {
  const files = [
    'agent-session.ts',
    'agent-session-abort-order.test.ts',
    'agent-session-command-errors.test.ts',
    'agent-session-model-switch.test.ts',
    'agent-session-renderable-tools.test.ts',
    'agent-session-thinking-level.test.ts',
    'agent-session-tool-refresh.test.ts',
    'sdk.ts',
    'sdk.test.ts',
    'sdk-tool-filter.test.ts',
    'compaction-orchestrator.ts',
    'compaction-orchestrator.test.ts',
    'compaction-threshold.test.ts',
    'compaction-utils.test.ts',
    'system-prompt.ts',
    'bash-executor.ts',
    'fallback-resolver.ts',
    'fallback-resolver.test.ts',
    'lifecycle-hooks.ts',
    'lifecycle-hooks.test.ts',
    'image-overflow-recovery.ts',
    'image-overflow-recovery.test.ts',
    'contextual-tips.ts',
    'contextual-tips.test.ts',
    'keybindings.ts',
    'artifact-manager.ts',
    'blob-store.ts',
  ]
  for (const f of files) {
    mv(join(PI, 'core', f), join(CORE, f))
  }
  mv(join(PI, 'core', 'compaction'), join(CORE, 'compaction'))
  mv(join(PI, 'core', 'export-html'), join(CORE, 'export-html'))
}

function moveThemeToPiCodingAgent() {
  const themeSrc = join(PI, 'modes/interactive/theme')
  const themeDest = join(PI, 'theme')
  if (existsSync(themeSrc)) {
    mv(themeSrc, themeDest)
  }
}

function moveAgentModes() {
  mv(join(PI, 'modes'), join(MODES, 'modes'))
  mv(join(PI, 'cli'), join(MODES, 'cli'))
  mv(join(PI, 'main.ts'), join(MODES, 'main.ts'))
}

function patchFile(file, replacements) {
  if (!existsSync(file)) return
  let content = readFileSync(file, 'utf8')
  let changed = false
  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      content = content.split(from).join(to)
      changed = true
    }
  }
  if (changed) writeFileSync(file, content)
}

function walkTs(dir, fn) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkTs(p, fn)
    else if (entry.name.endsWith('.ts')) fn(p)
  }
}

function fixImportsInTree(dir, isModes) {
  const piCorePrefix = isModes ? '../core/' : './'
  walkTs(dir, (file) => {
    patchFile(file, [
      ['../modes/interactive/theme/', '../../pi-coding-agent/src/theme/'],
      ['../../modes/interactive/theme/', '../../pi-coding-agent/src/theme/'],
      ['../theme/', '@gsd/pi-coding-agent/dist/theme/'],
      ['from "../config.js"', 'from "@gsd/pi-coding-agent/dist/config.js"'],
      ['from "../../config.js"', 'from "@gsd/pi-coding-agent/dist/config.js"'],
      ['from "../migrations.js"', 'from "@gsd/pi-coding-agent/dist/migrations.js"'],
      ['from "./core/agent-session.js"', 'from "./agent-session.js"'],
      ['from "./core/sdk.js"', 'from "./sdk.js"'],
      ['from "./core/compaction-orchestrator.js"', 'from "./compaction-orchestrator.js"'],
      ['from "./core/keybindings.js"', 'from "./keybindings.js"'],
      ['from "./core/export-html/index.js"', 'from "./export-html/index.js"'],
      ['from "../core/extensions/', 'from "@gsd/pi-coding-agent/dist/core/extensions/'],
      ['from "./core/extensions/', 'from "@gsd/pi-coding-agent/dist/core/extensions/'],
      ['from "../core/auth-storage.js"', 'from "@gsd/pi-coding-agent/dist/core/auth-storage.js"'],
      ['from "../core/model-registry.js"', 'from "@gsd/pi-coding-agent/dist/core/model-registry.js"'],
      ['from "../core/model-resolver.js"', 'from "@gsd/pi-coding-agent/dist/core/model-resolver.js"'],
      ['from "../core/package-commands.js"', 'from "@gsd/pi-coding-agent/dist/core/package-commands.js"'],
      ['from "../core/package-manager.js"', 'from "@gsd/pi-coding-agent/dist/core/package-manager.js"'],
      ['from "../core/resource-loader.js"', 'from "@gsd/pi-coding-agent/dist/core/resource-loader.js"'],
      ['from "../core/session-manager.js"', 'from "@gsd/pi-coding-agent/dist/core/session-manager.js"'],
      ['from "../core/settings-manager.js"', 'from "@gsd/pi-coding-agent/dist/core/settings-manager.js"'],
      ['from "../core/timings.js"', 'from "@gsd/pi-coding-agent/dist/core/timings.js"'],
      ['from "../core/tools/index.js"', 'from "@gsd/pi-coding-agent/dist/core/tools/index.js"'],
      ['from "./core/tools/', 'from "@gsd/pi-coding-agent/dist/core/tools/'],
      ['from "../utils/', 'from "@gsd/pi-coding-agent/dist/utils/'],
      ['from "../../utils/', 'from "@gsd/pi-coding-agent/dist/utils/'],
      ['from "./bash-executor.js"', 'from "@gsd/agent-core/dist/bash-executor.js"'],
      ['from "./compaction-orchestrator.js"', 'from "@gsd/agent-core/dist/compaction-orchestrator.js"'],
      ['from "./keybindings.js"', 'from "@gsd/agent-core/dist/keybindings.js"'],
      ['from "./core/sdk.js"', 'from "@gsd/agent-core/dist/sdk.js"'],
      ['from "../core/sdk.js"', 'from "@gsd/agent-core/dist/sdk.js"'],
      ['from "./core/agent-session.js"', 'from "@gsd/agent-core/dist/agent-session.js"'],
      ['from "../core/agent-session.js"', 'from "@gsd/agent-core/dist/agent-session.js"'],
    ])
  })
}

moveThemeToPiCodingAgent()
moveAgentCore()
moveAgentModes()

// Fix theme imports in remaining pi-coding-agent tree
walkTs(PI, (file) => {
  patchFile(file, [
    ['modes/interactive/theme/', 'theme/'],
    ['../modes/interactive/theme/', '../theme/'],
    ['../../modes/interactive/theme/', '../../theme/'],
    ['../../../modes/interactive/theme/', '../../../theme/'],
  ])
})

fixImportsInTree(CORE, false)
fixImportsInTree(MODES, true)

console.log('Migration file moves complete. Run manual import fixes and build.')
