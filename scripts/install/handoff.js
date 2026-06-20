import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { getGlobalPaths } from './npm-global.js'

/** Set on `gsd config` spawned from the installer so loader/onboarding skip the wordmark. */
export const GSD_SUPPRESS_LOGO_ENV = 'GSD_SUPPRESS_LOGO'

export function resolveGsdBin({ isLocal, cwd = process.cwd() }) {
  if (isLocal) {
    const localBin = join(cwd, 'node_modules', '.bin', 'gsd')
    if (existsSync(localBin)) return localBin
    if (process.platform === 'win32' && existsSync(`${localBin}.cmd`)) {
      return `${localBin}.cmd`
    }
    return localBin
  }

  const { binDir } = getGlobalPaths()
  const globalBin = join(binDir, process.platform === 'win32' ? 'gsd.cmd' : 'gsd')
  if (existsSync(globalBin)) return globalBin
  return join(binDir, 'gsd')
}

// On Windows, .cmd shims cannot be executed directly by spawnSync without a
// shell. Use `cmd /c <bin> <args>` to avoid both ENOENT failures and the
// Node 22 DEP0190 deprecation triggered by `shell: true` with args.
function buildSpawnInvocation(bin, args) {
  if (process.platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', bin, ...args] }
  }
  return { cmd: bin, args }
}

export function runConfigHandoff({ bin, nonInteractive }) {
  if (nonInteractive) return { skipped: true }

  const inv = buildSpawnInvocation(bin, ['config'])
  const result = spawnSync(inv.cmd, inv.args, {
    stdio: 'inherit',
    timeout: 600_000,
    env: { ...process.env, [GSD_SUPPRESS_LOGO_ENV]: '1' },
  })

  if (result.error || (result.status != null && result.status !== 0)) {
    process.stderr.write(
      `\nFailed to run provider setup.\n` +
      `Run manually: ${bin} config\n\n`,
    )
    process.exit(1)
  }

  return { skipped: false }
}

export async function promptLaunch({ bin, clack: p, nonInteractive }) {
  if (nonInteractive) return false

  const launch = await p.confirm({
    message: 'Launch GSD now?',
    initialValue: true,
  })

  if (p.isCancel(launch) || !launch) return false

  const inv = buildSpawnInvocation(bin, [])
  const result = spawnSync(inv.cmd, inv.args, {
    stdio: 'inherit',
  })

  if (result.error || (result.status != null && result.status !== 0)) {
    process.exit(result.status ?? 1)
  }

  return true
}

export function verifyInstall(bin) {
  const inv = buildSpawnInvocation(bin, ['--version'])
  const result = spawnSync(inv.cmd, inv.args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })

  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim()
  }
  return null
}
