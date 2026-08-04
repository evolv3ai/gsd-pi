/**
 * Models.json resolution for GSD.
 *
 * Uses ~/.gsd/agent/models.json exclusively.
 */

import { dirname, join } from 'node:path'
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

/**
 * Resolve the path to the runtime model-catalog overlay.
 *
 * Always the sibling of models.json. Refreshed by `gsd update --models`;
 * merged at startup between the bundled catalog and models.json.
 *
 * @returns The path to use for models-catalog.json
 */
export function resolveModelsCatalogPath(): string {
  return join(dirname(GSD_MODELS_PATH), 'models-catalog.json')
}
