/**
 * `gsd read` — JSON read seam for integrations (Hermes 6c).
 *
 *   gsd read progress --json --project /path
 *   gsd read roadmap --json --project /path [--milestone M001]
 *   gsd read memory --json --project /path --query "auth"
 */

import { resolve } from 'node:path'
import { graphQuery } from '@opengsd/mcp-server/readers/graph'
import { resolveGsdRoot } from '@opengsd/mcp-server/readers/paths'
import { readRoadmap } from '@opengsd/mcp-server/readers/roadmap'
import { readProgress } from '@opengsd/mcp-server/readers/state'

export const INTEGRATION_VERSION = 1

export type ReadKind = 'progress' | 'roadmap' | 'memory'

export interface ReadEnvelope<T = unknown> {
  integration_version: number
  kind: ReadKind
  projectDir: string
  data: T
}

export interface ReadCliOptions {
  kind: ReadKind
  project: string
  milestone?: string
  query?: string
  json: boolean
}

function parseReadArgs(argv: string[]): ReadCliOptions | null {
  const readIndex = argv.indexOf('read', 2)
  if (readIndex === -1) return null
  const args = argv.slice(readIndex + 1)
  if (args.length < 1) return null
  const kind = args[0] as ReadKind
  if (!['progress', 'roadmap', 'memory'].includes(kind)) return null

  let project: string | undefined
  let milestone: string | undefined
  let query: string | undefined
  let json = false

  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') json = true
    else if (a === '--project' && i + 1 < args.length) project = args[++i]
    else if (a === '--milestone' && i + 1 < args.length) milestone = args[++i]
    else if (a === '--query' && i + 1 < args.length) query = args[++i]
  }

  if (!project) return null
  return { kind, project, milestone, query, json }
}

export async function runReadCli(argv: string[]): Promise<number> {
  const opts = parseReadArgs(argv)
  if (!opts) {
    process.stderr.write(
      'Usage: gsd read <progress|roadmap|memory> --json --project <path> [--milestone M001] [--query text]\n',
    )
    return 1
  }

  const projectDir = resolve(opts.project)
  try {
    resolveGsdRoot(projectDir)
  } catch (err) {
    process.stderr.write(
      `[gsd read] ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  let data: unknown
  switch (opts.kind) {
    case 'progress':
      data = readProgress(projectDir)
      break
    case 'roadmap':
      data = readRoadmap(projectDir, opts.milestone)
      break
    case 'memory': {
      const term = opts.query?.trim() || ''
      if (term.length < 2) {
        process.stderr.write('[gsd read] memory requires --query with at least 2 characters\n')
        return 1
      }
      data = await graphQuery(projectDir, term)
      break
    }
    default:
      return 1
  }

  const envelope: ReadEnvelope = {
    integration_version: INTEGRATION_VERSION,
    kind: opts.kind,
    projectDir,
    data,
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n')
  } else {
    process.stdout.write(JSON.stringify(envelope.data, null, 2) + '\n')
  }
  return 0
}
