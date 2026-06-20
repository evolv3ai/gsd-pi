import { execFileSync as nodeExecFileSync } from 'node:child_process'
import { existsSync as nodeExistsSync, realpathSync as nodeRealpathSync, readFileSync as nodeReadFileSync } from 'node:fs'
import { delimiter, dirname, extname, join, resolve as resolvePath } from 'node:path'

export const CLAUDE_CODE_RUNTIME_FLOOR = '2.1.168'
export const CLAUDE_CODE_PROVIDER = 'claude-code'
export const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code'

interface ClaudeRuntimeSettings {
  defaultProvider?: string
  defaultModel?: string
}

interface FileDeps {
  existsSync?: typeof nodeExistsSync
  readFileSync?: typeof nodeReadFileSync
  realpathSync?: typeof nodeRealpathSync
}

type ExecFileSyncLike = (
  command: string,
  args?: readonly string[],
  options?: Parameters<typeof nodeExecFileSync>[2],
) => Buffer | string

export interface ClaudeRuntimeFloorOptions extends FileDeps {
  agentDir: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  execFileSync?: ExecFileSyncLike
  platform?: NodeJS.Platform
}

export interface ClaudeRuntimeProbe {
  command: string
  displayPath: string | null
  realPath: string | null
  version: string
}

interface UpgradeCommandInfo {
  command: string | null
  source: 'npm' | 'pnpm' | 'bun' | 'homebrew' | 'winget' | 'native' | 'unknown'
}

const VERSION_TIMEOUT_MS = 5_000

function compareVersionTriplets(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftValue = left[index] || 0
    const rightValue = right[index] || 0
    if (leftValue > rightValue) return 1
    if (leftValue < rightValue) return -1
  }
  return 0
}

export function parseClaudeRuntimeVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null
}

export function isClaudeCodeConfigured(settings: ClaudeRuntimeSettings): boolean {
  if (settings.defaultProvider === CLAUDE_CODE_PROVIDER) return true
  return settings.defaultModel?.startsWith(`${CLAUDE_CODE_PROVIDER}/`) ?? false
}

function readSettingsFile(path: string, deps: Required<Pick<FileDeps, 'existsSync' | 'readFileSync'>>): ClaudeRuntimeSettings {
  try {
    if (!deps.existsSync(path)) return {}
    const raw = JSON.parse(deps.readFileSync(path, 'utf-8') as string) as ClaudeRuntimeSettings
    return {
      ...(typeof raw.defaultProvider === 'string' ? { defaultProvider: raw.defaultProvider } : {}),
      ...(typeof raw.defaultModel === 'string' ? { defaultModel: raw.defaultModel } : {}),
    }
  } catch {
    return {}
  }
}

export function loadClaudeRuntimeSettings(options: Pick<ClaudeRuntimeFloorOptions, 'agentDir' | 'cwd' | 'existsSync' | 'readFileSync'>): ClaudeRuntimeSettings {
  const deps = {
    existsSync: options.existsSync ?? nodeExistsSync,
    readFileSync: options.readFileSync ?? nodeReadFileSync,
  }
  const globalSettings = readSettingsFile(join(options.agentDir, 'settings.json'), deps)
  const projectSettings = options.cwd
    ? readSettingsFile(join(options.cwd, '.gsd', 'settings.json'), deps)
    : {}

  return {
    ...globalSettings,
    ...projectSettings,
  }
}

export function buildClaudeSpawnInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', command, ...args] }
  }
  return { command, args }
}

export function getClaudeRuntimeCommandCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude']
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '')
    .split(delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
}

function executableNames(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || extname(command)) return [command]
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  return [command, ...extensions.map(extension => `${command}${extension}`)]
}

export function resolveExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  existsSync: typeof nodeExistsSync = nodeExistsSync,
): string | null {
  if (dirname(command) !== '.') {
    return existsSync(command) ? resolvePath(command) : null
  }

  for (const entry of pathEntries(env)) {
    for (const name of executableNames(command, env, platform)) {
      const candidate = join(entry, name)
      if (existsSync(candidate)) return resolvePath(candidate)
    }
  }
  return null
}

function realpathOrNull(path: string | null, realpathSync: typeof nodeRealpathSync): string | null {
  if (!path) return null
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function probeClaudeRuntime(options: Omit<ClaudeRuntimeFloorOptions, 'agentDir' | 'cwd'> = {}): ClaudeRuntimeProbe | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const execFileSync = options.execFileSync ?? nodeExecFileSync
  const existsSync = options.existsSync ?? nodeExistsSync
  const realpathSync = options.realpathSync ?? nodeRealpathSync

  for (const command of getClaudeRuntimeCommandCandidates(platform)) {
    try {
      const invocation = buildClaudeSpawnInvocation(command, ['--version'], platform)
      const output = execFileSync(invocation.command, invocation.args, {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: VERSION_TIMEOUT_MS,
      })
      const version = parseClaudeRuntimeVersion(String(output))
      if (!version) continue

      const displayPath = resolveExecutablePath(command, env, platform, existsSync)
      return {
        command,
        displayPath,
        realPath: realpathOrNull(displayPath, realpathSync),
        version,
      }
    } catch {
      continue
    }
  }

  return null
}

function normalizedPath(value: string | null | undefined): string {
  return (value ?? '').replace(/\\/g, '/').toLowerCase()
}

export function inferClaudeRuntimeUpgradeCommand(probe: Pick<ClaudeRuntimeProbe, 'displayPath' | 'realPath'>, platform: NodeJS.Platform = process.platform): UpgradeCommandInfo {
  const combined = `${normalizedPath(probe.displayPath)}\n${normalizedPath(probe.realPath)}`

  if (combined.includes('/.pnpm/') && combined.includes('@anthropic-ai+claude-code@')) {
    return { command: `pnpm add -g ${CLAUDE_CODE_PACKAGE}@latest`, source: 'pnpm' }
  }
  if (combined.includes('/node_modules/') && combined.includes('/@anthropic-ai/claude-code/')) {
    return { command: `npm install -g ${CLAUDE_CODE_PACKAGE}@latest`, source: 'npm' }
  }
  if (combined.includes('/.bun/') || combined.includes('/bun/install/global/')) {
    return { command: `bun add -g ${CLAUDE_CODE_PACKAGE}@latest`, source: 'bun' }
  }
  if (combined.includes('/homebrew/') || combined.includes('/caskroom/claude-code')) {
    return { command: 'brew upgrade claude-code', source: 'homebrew' }
  }
  if (platform === 'win32' && (combined.includes('/winget/') || combined.includes('/anthropic.claudecode'))) {
    return { command: 'winget upgrade Anthropic.ClaudeCode', source: 'winget' }
  }
  if (combined.includes('claude code.app') || combined.includes('/anthropic/claude')) {
    return { command: null, source: 'native' }
  }
  return { command: null, source: 'unknown' }
}

export function formatClaudeRuntimeFloorAdvisory(
  probe: ClaudeRuntimeProbe,
  floor: string = CLAUDE_CODE_RUNTIME_FLOOR,
  platform: NodeJS.Platform = process.platform,
): string {
  const upgrade = inferClaudeRuntimeUpgradeCommand(probe, platform)
  const pathText = probe.displayPath ? ` at ${probe.displayPath}` : ''
  const base =
    `Warning: Claude Code Runtime is below GSD's validated floor: detected v${probe.version}, expected >= v${floor}. ` +
    'GSD can still update, but older Claude Code may silently reduce output quality or miss model/runtime features.'

  if (upgrade.command) {
    return `${base} Upgrade the claude binary${pathText} with: ${upgrade.command}`
  }
  return (
    `${base} Upgrade the claude binary${pathText} using the method you installed it with. ` +
    'See docs/user-docs/claude-code-subscription.md#upgrade-claude-code.'
  )
}

export function buildClaudeRuntimeFloorAdvisory(options: ClaudeRuntimeFloorOptions): string | null {
  const settings = loadClaudeRuntimeSettings(options)
  if (!isClaudeCodeConfigured(settings)) return null

  const probe = probeClaudeRuntime(options)
  if (!probe) return null
  if (compareVersionTriplets(probe.version, CLAUDE_CODE_RUNTIME_FLOOR) >= 0) return null

  return formatClaudeRuntimeFloorAdvisory(probe, CLAUDE_CODE_RUNTIME_FLOOR, options.platform)
}
