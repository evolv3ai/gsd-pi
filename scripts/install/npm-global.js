import { execFile, execFileSync } from 'child_process'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

function getNpm() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function runNpm(args) {
  return execFileSync(getNpm(), args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    shell: process.platform === 'win32',
  }).trim()
}

function formatNpmFailure(result) {
  const output = `${result.stderr}\n${result.stdout}`.trim()
  const meaningful = output
    .split('\n')
    .filter((line) => !line.includes('npm warn') && !line.includes('npm WARN') && line.trim())
    .slice(-3)
    .join('; ')
  return meaningful || result.error?.message || 'npm install failed'
}

async function runNpmAsync(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(getNpm(), args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      shell: process.platform === 'win32',
      ...options,
    })
    return { ok: true, stdout: stdout || '', stderr: stderr || '' }
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error,
    }
  }
}

export function getGlobalPaths() {
  const prefix = runNpm(['prefix', '-g'])
  const root = runNpm(['root', '-g'])
  return {
    prefix,
    root,
    binDir: join(prefix, 'bin'),
    packageRoot: join(root, '@opengsd', 'gsd-pi'),
  }
}

export function getLocalPackageRoot(cwd = process.cwd()) {
  return join(cwd, 'node_modules', '@opengsd', 'gsd-pi')
}

export async function installGlobalPackage(version) {
  const result = await runNpmAsync([
    'install',
    '-g',
    '--ignore-scripts',
    `@opengsd/gsd-pi@${version}`,
  ])
  if (!result.ok) {
    throw new Error(formatNpmFailure(result))
  }
  return getGlobalPaths().packageRoot
}

export async function installLocalPackage(version, cwd = process.cwd()) {
  const result = await runNpmAsync(
    ['install', '--ignore-scripts', `@opengsd/gsd-pi@${version}`],
    { cwd },
  )
  if (!result.ok) {
    throw new Error(formatNpmFailure(result))
  }
  return getLocalPackageRoot(cwd)
}
