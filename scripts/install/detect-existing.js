/**
 * Parse @opengsd/gsd-pi version from `npm list -g --json` output.
 */

import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { detectPackageManager } from './npm-global.js'

const require = createRequire(import.meta.url)
const { GSD_PI_BRAND } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'logo.cjs'))

export function parseInstalledVersion(npmListJson) {
  if (Array.isArray(npmListJson)) {
    for (const entry of npmListJson) {
      const found = parseInstalledVersion(entry)
      if (found) return found
    }
    return null
  }

  if (!npmListJson || typeof npmListJson !== 'object') return null

  const direct = npmListJson.dependencies?.['@opengsd/gsd-pi']?.version
  if (direct) return direct

  function walk(node) {
    if (!node || typeof node !== 'object') return null
    if (node.name === '@opengsd/gsd-pi' && node.version) return node.version

    for (const [depName, dep] of Object.entries(node.dependencies || {})) {
      if (depName === '@opengsd/gsd-pi' && dep?.version) return dep.version
      const found = walk(dep)
      if (found) return found
    }
    return null
  }

  return walk(npmListJson)
}

function getPackageManagerBin(packageManager) {
  return process.platform === 'win32' ? `${packageManager}.cmd` : packageManager
}

/**
 * Decide install action for non-interactive or pre-prompt routing.
 */
export function compareActions({ installed, yesMode }) {
  if (!installed) return 'fresh'
  if (yesMode) return 'upgrade'
  return 'prompt'
}

export async function detectInstalledVersion(options = {}) {
  const { execFileSync } = await import('child_process')
  const packageManager = options.packageManager ?? detectPackageManager()
  const bin = getPackageManagerBin(packageManager)
  try {
    const raw = execFileSync(bin, ['list', '-g', '@opengsd/gsd-pi', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      shell: process.platform === 'win32',
    })
    const json = JSON.parse(raw)
    return parseInstalledVersion(json)
  } catch {
    return null
  }
}

export async function promptExistingAction({ installedVersion, targetVersion, clack: p }) {
  const choice = await p.select({
    message: `${GSD_PI_BRAND} v${targetVersion} installer — you have v${installedVersion} installed`,
    options: [
      { value: 'upgrade', label: `Upgrade to v${targetVersion}` },
      { value: 'reconfigure', label: 'Reconfigure provider settings' },
      { value: 'cancel', label: 'Cancel' },
    ],
  })

  if (p.isCancel(choice)) return 'cancel'
  return choice
}

export async function resolveInstallAction({ targetVersion, yesMode, clack: p }) {
  const installedVersion = await detectInstalledVersion()
  if (!installedVersion) return { action: 'fresh', installedVersion: null }

  const mode = compareActions({ installed: installedVersion, yesMode })
  if (mode === 'upgrade') return { action: 'upgrade', installedVersion }
  if (mode === 'fresh') return { action: 'fresh', installedVersion: null }

  const action = await promptExistingAction({ installedVersion, targetVersion, clack: p })
  return { action, installedVersion }
}
