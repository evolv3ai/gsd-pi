#!/usr/bin/env node
/**
 * vendor-pi-deps.cjs — vendor pi-agent-core, pi-ai, pi-tui only (not pi-coding-agent).
 * Keeps ADR-010 seamed pi-coding-agent intact.
 */
'use strict'

const { existsSync, readFileSync, writeFileSync, rmSync, cpSync } = require('fs')
const { join, resolve } = require('path')
const { execSync } = require('child_process')

const REPO_ROOT = resolve(__dirname, '..')
const CACHE_DIR = join(REPO_ROOT, '.cache', 'pi-upstream')

const PACKAGES = [
  ['packages/agent', 'packages/pi-agent-core', '@gsd/pi-agent-core'],
  ['packages/ai', 'packages/pi-ai', '@gsd/pi-ai'],
  ['packages/tui', 'packages/pi-tui', '@gsd/pi-tui'],
]

function preserveGsdPackageJson(targetDir, upstreamPkgJson, gsdName) {
  const gsdPkgPath = join(targetDir, 'package.json')
  let gsdFields = {}
  if (existsSync(gsdPkgPath)) {
    const existing = JSON.parse(readFileSync(gsdPkgPath, 'utf8'))
    gsdFields = {
      name: existing.name,
      version: existing.version,
      description: existing.description,
      gsd: existing.gsd,
      piConfig: existing.piConfig,
    }
  }
  const merged = { ...upstreamPkgJson, ...gsdFields }
  delete merged.publishConfig
  if (gsdName) merged.name = gsdName
  return merged
}

for (const [upstreamSubdir, targetSubdir, gsdName] of PACKAGES) {
  const src = join(CACHE_DIR, upstreamSubdir)
  const dest = join(REPO_ROOT, targetSubdir)
  if (!existsSync(src)) {
    throw new Error(`Missing upstream package: ${src}`)
  }
  process.stderr.write(`Copy ${upstreamSubdir} → ${targetSubdir}\n`)
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  const upstreamPkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
  writeFileSync(join(dest, 'package.json'), JSON.stringify(preserveGsdPackageJson(dest, upstreamPkg, gsdName), null, 2) + '\n')
}

execSync('node scripts/normalize-pi-imports.cjs', { cwd: REPO_ROOT, stdio: 'inherit' })
execSync('node scripts/apply-gsd-pi-package-json.cjs', { cwd: REPO_ROOT, stdio: 'inherit' })
execSync('node scripts/restore-pi-tsconfig.cjs', { cwd: REPO_ROOT, stdio: 'inherit' })
process.stderr.write('vendor-pi-deps: done\n')
