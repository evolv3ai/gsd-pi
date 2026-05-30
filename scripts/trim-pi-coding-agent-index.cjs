#!/usr/bin/env node
'use strict'

const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const ROOT = join(__dirname, '..')
const INDEX = join(ROOT, 'packages/pi-coding-agent/src/index.ts')

let src = execSync('git show HEAD:packages/pi-coding-agent/src/index.ts', {
  cwd: ROOT,
  encoding: 'utf8',
})

src = src.replace(
  /\/\/ Core session management[\s\S]*?from "\.\/core\/agent-session\.js";\n/,
  '// Config paths\nexport { getAgentDir, VERSION, APP_NAME } from "./config.js";\n',
)
src = src.replace(/\/\/ Compaction[\s\S]*?from "\.\/core\/compaction\/index\.js";\n/, '')
src = src.replace(/\/\/ SDK for programmatic usage[\s\S]*?from "\.\/core\/sdk\.js";\n/, '')
src = src.replace(/\/\/ Main entry point[\s\S]*?from "\.\/main\.js";\n/, '')
src = src.replace(/\/\/ Run modes for programmatic SDK usage[\s\S]*?from "\.\/modes\/index\.js";\n/, '')
src = src.replace(/\/\/ RPC JSONL utilities[\s\S]*?from "\.\/modes\/rpc\/jsonl\.js";\n/, '')
src = src.replace(/\/\/ UI components for extensions[\s\S]*?from "\.\/modes\/interactive\/components\/index\.js";\n/, '')
src = src.replace(/from "\.\/modes\/interactive\/theme\/theme\.js"/g, 'from "./theme/theme.js"')
src = src.replace(
  /(\tcodingTools,\n)/,
  '$1\tcreateBashTool,\n\tcreateEditTool,\n\tcreateReadTool,\n\tcreateWriteTool,\n\tcreateCodingTools,\n\tcreateFindTool,\n\tcreateGrepTool,\n\tcreateLsTool,\n\tcreateReadOnlyTools,\n\treadOnlyTools,\n',
)

writeFileSync(INDEX, src)
process.stderr.write('trim-pi-coding-agent-index: wrote trimmed index.ts\n')
