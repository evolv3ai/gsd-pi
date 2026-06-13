import { homedir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'

function hasPnpmPath(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.includes('/.pnpm/') ||
    normalized.endsWith('/pnpm') ||
    normalized.endsWith('/pnpm.cjs') ||
    normalized.endsWith('/pnpm.js')
  )
}

export function pathStartsWith(pathValue: string | undefined, dir: string): boolean {
  if (!pathValue) return false
  const resolvedPath = resolvePath(pathValue)
  const resolvedDir = resolvePath(dir)
  return resolvedPath === resolvedDir || resolvedPath.startsWith(resolvedDir + sep)
}

// Shared by update-check.ts and gsd command handlers. The JS installer keeps a
// parallel copy because it runs before TypeScript output exists.
export function isPnpmInstall(
  argv1: string | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.npm_config_user_agent?.startsWith('pnpm/')) return true
  if (hasPnpmPath(env.npm_execpath)) return true
  if (hasPnpmPath(argv1)) return true
  if (!argv1) return false

  const pnpmBinDirs: string[] = []
  if (env.PNPM_HOME) pnpmBinDirs.push(env.PNPM_HOME)
  pnpmBinDirs.push(join(homedir(), 'Library', 'pnpm'))
  pnpmBinDirs.push(join(homedir(), '.local', 'share', 'pnpm'))

  return pnpmBinDirs.some((dir) => pathStartsWith(argv1, dir) || pathStartsWith(env.npm_execpath, dir))
}
