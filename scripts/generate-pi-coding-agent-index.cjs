#!/usr/bin/env node
/** generate-pi-coding-agent-index.cjs — build seamed index.ts from upstream v0.75.5. */
'use strict'

const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const UP = join(ROOT, '.cache/pi-upstream/packages/coding-agent/src/index.ts')
const OUT = join(ROOT, 'packages/pi-coding-agent/src/index.ts')

let src = readFileSync(UP, 'utf8')
src = src.replace(/\.ts"/g, '.js"')
src = src.replace(/\.ts'/g, ".js'")

// Keep config export at top
if (!src.includes('getAgentDir')) {
  src = `// Config paths\nexport { getAgentDir, VERSION, APP_NAME } from "./config.js";\n` + src
}

// ADR-010 seam: agent session + compaction + sdk + modes live in gsd-agent-* 
src = src.replace(/\/\/ Core session management[\s\S]*?from "\.\/core\/agent-session\.js";\n/, '')
src = src.replace(/\/\/ Compaction[\s\S]*?from "\.\/core\/compaction\/index\.js";\n/, '')
src = src.replace(/\/\/ SDK for programmatic usage[\s\S]*?from "\.\/core\/sdk\.js";\n/, '')
src = src.replace(/\/\/ Main entry point[\s\S]*?from "\.\/main\.js";\n/, '')
src = src.replace(/\/\/ Run modes for programmatic SDK usage[\s\S]*?from "\.\/modes\/index\.js";\n/, '')
src = src.replace(/\/\/ UI components for extensions[\s\S]*?from "\.\/modes\/interactive\/components\/index\.js";\n/, '')
src = src.replace(
	/from "\.\/modes\/interactive\/theme\/theme\.js"/g,
	'from "./theme/theme.js"',
)

// GSD additions
src += `
// GSD-specific exports (protected during upstream vendoring)
export { FallbackResolver } from "./core/fallback-resolver.js";
export {
\tprepareLifecycleHooks,
\trunLifecycleHooks,
\treadManifestRuntimeDeps,
\tcollectRuntimeDependencies,
\tverifyRuntimeDependencies,
\tresolveLocalSourcePath,
} from "./core/lifecycle-hooks.js";
export {
\tBlobStore,
\texternalizeImageData,
\tisBlobRef,
\tparseBlobRef,
\tresolveImageData,
} from "./core/blob-store.js";
export { ArtifactManager } from "./core/artifact-manager.js";
export { toPosixPath } from "./utils/path-display.js";
`

writeFileSync(OUT, src)
process.stderr.write('generate-pi-coding-agent-index: wrote index.ts\n')
