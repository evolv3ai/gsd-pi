/**
 * Models.json resolution for GSD.
 *
 * Uses ~/.gsd/agent/models.json exclusively.
 */

import { join } from 'node:path'
import { agentDir } from './app-paths.js'

const GSD_MODELS_PATH = join(agentDir, 'models.json')

/**
 * Resolve the path to models.json.
 *
 * @returns The path to use for models.json
 */
export function resolveModelsJsonPath(): string {
  return GSD_MODELS_PATH
}
