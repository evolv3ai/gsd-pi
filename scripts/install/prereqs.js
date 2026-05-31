import { execFileSync } from 'child_process'
import { delimiter } from 'path'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const runtimeChecksFallback = {
  MIN_NODE_MAJOR: 22,
  checkNodeVersion(versionString, min = 22) {
    const major = parseInt(versionString.split('.')[0], 10)
    if (!Number.isFinite(major)) {
      throw new Error(`checkNodeVersion: cannot parse major from "${versionString}"`)
    }
    return major < min ? { ok: false, actualMajor: major } : { ok: true }
  },
  requireGit(execFn) {
    try {
      execFn('git', ['--version'])
      return true
    } catch {
      return false
    }
  },
}

function isRequireEsmError(err) {
  return err && typeof err === 'object' && err.code === 'ERR_REQUIRE_ESM'
}

export function loadRuntimeChecks(requireRuntimeChecks = require) {
  const distPath = join(__dirname, '..', '..', 'dist', 'runtime-checks.js')
  try {
    return requireRuntimeChecks(distPath)
  } catch (err) {
    if (isRequireEsmError(err)) return runtimeChecksFallback
    throw new Error(
      'dist/runtime-checks.js not found — run npm run build before using the npx installer',
      { cause: err },
    )
  }
}

/**
 * Returns true when globalBinDir appears in pathEnv (case-insensitive on Windows).
 */
export function isPathConfigured(globalBinDir, pathEnv = process.env.PATH || '') {
  const normalizedBin = process.platform === 'win32'
    ? globalBinDir.toLowerCase()
    : globalBinDir
  const parts = pathEnv.split(delimiter).filter(Boolean)
  return parts.some((part) => {
    const normalized = process.platform === 'win32' ? part.toLowerCase() : part
    return normalized === normalizedBin
  })
}

function runNpm(args) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return execFileSync(npm, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    shell: process.platform === 'win32',
  }).trim()
}

export function execGitCommand(cmd, args) {
  return execFileSync(cmd, args, { stdio: 'ignore' })
}

export function getGlobalBinDir() {
  const prefix = runNpm(['prefix', '-g'])
  return process.platform === 'win32' ? prefix : join(prefix, 'bin')
}

export function checkPrereqs({ isLocal, log }) {
  const { checkNodeVersion, requireGit, MIN_NODE_MAJOR } = loadRuntimeChecks()

  const nodeCheck = checkNodeVersion(process.versions.node, MIN_NODE_MAJOR)
  if (!nodeCheck.ok) {
    log?.fail?.(
      'Node.js',
      `GSD requires Node.js >= ${MIN_NODE_MAJOR}.0.0 (you have ${process.versions.node})`,
    )
    process.stderr.write(
      `\nError: GSD requires Node.js >= ${MIN_NODE_MAJOR}.0.0\n` +
      `       You are running Node.js ${process.versions.node}\n\n`,
    )
    process.exit(1)
  }
  log?.step?.('Node.js', `v${process.versions.node}`)

  const gitOk = requireGit(execGitCommand)
  if (!gitOk) {
    process.stderr.write(
      '\nError: GSD requires git but it was not found on PATH.\n\n' +
      'Install git:\n  https://git-scm.com/downloads\n\n',
    )
    process.exit(1)
  }
  log?.step?.('git', 'found')

  if (isLocal) return { pathWarning: null }

  const globalBinDir = getGlobalBinDir()
  if (!isPathConfigured(globalBinDir)) {
    const shellHint = process.platform === 'win32'
      ? `set PATH=${globalBinDir};%PATH%`
      : `export PATH="${globalBinDir}:$PATH"`
    const warning =
      `Global npm bin (${globalBinDir}) is not in PATH.\n` +
      `  Add to your shell profile:  ${shellHint}\n` +
      '  Continuing install...'
    log?.warn?.('PATH', warning)
    return { pathWarning: warning, globalBinDir, shellHint }
  }

  log?.step?.('PATH', 'global npm bin configured')
  return { pathWarning: null, globalBinDir }
}
