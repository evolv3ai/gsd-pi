import { execFileSync, spawn } from 'child_process'
import { join } from 'path'

function getNpm() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

const NPM_OUTPUT_LIMIT = 64 * 1024

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

function appendLimited(value, chunk) {
  if (value.length >= NPM_OUTPUT_LIMIT) return value
  return value + chunk.slice(0, NPM_OUTPUT_LIMIT - value.length)
}

function runNpmAsync(args, {
  captureStdout = false,
  cwd,
  timeout = 300_000,
} = {}) {
  const npm = getNpm()

  return new Promise((resolve) => {
    const child = spawn(npm, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)

    const finishError = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr, error: err })
    }

    if (captureStdout) {
      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', (chunk) => {
        stdout = appendLimited(stdout, chunk)
      })
    }

    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk)
    })

    child.on('error', finishError)
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (timedOut) {
        resolve({
          ok: false,
          stdout,
          stderr,
          error: new Error(`npm ${args.join(' ')} timed out after ${timeout}ms`),
        })
        return
      }

      if (code === 0) {
        resolve({ ok: true, stdout, stderr })
        return
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      resolve({
        ok: false,
        stdout,
        stderr,
        error: new Error(`npm ${args.join(' ')} failed with ${reason}`),
      })
    })
  })
}

export function getGlobalPaths() {
  const prefix = runNpm(['prefix', '-g'])
  const root = runNpm(['root', '-g'])
  return {
    prefix,
    root,
    binDir: process.platform === 'win32' ? prefix : join(prefix, 'bin'),
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
  const rootResult = await runNpmAsync(['root', '-g'], {
    captureStdout: true,
    timeout: 120_000,
  })
  if (!rootResult.ok) {
    throw new Error(formatNpmFailure(rootResult))
  }
  return join(rootResult.stdout.trim(), '@opengsd', 'gsd-pi')
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
