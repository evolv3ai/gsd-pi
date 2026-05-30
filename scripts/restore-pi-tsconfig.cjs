#!/usr/bin/env node
/** Restore GSD tsc tsconfig.json for vendored pi packages (upstream uses tsconfig.build.json). */
'use strict'

const { writeFileSync, existsSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const ROOT = join(__dirname, '..')
const PACKAGES = ['pi-agent-core', 'pi-ai', 'pi-tui']

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2024',
    module: 'Node16',
    lib: ['ES2024'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    incremental: false,
    forceConsistentCasingInFileNames: true,
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    inlineSources: true,
    inlineSourceMap: false,
    moduleResolution: 'Node16',
    resolveJsonModule: true,
    allowImportingTsExtensions: false,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    useDefineForClassFields: false,
    types: ['node'],
    outDir: './dist',
    rootDir: './src',
  },
  include: ['src/**/*'],
  exclude: ['node_modules', 'dist'],
}

for (const pkg of PACKAGES) {
  const dest = join(ROOT, 'packages', pkg, 'tsconfig.json')
  let config = TSCONFIG
  try {
    config = JSON.parse(
      execSync(`git show HEAD:packages/${pkg}/tsconfig.json`, { cwd: ROOT, encoding: 'utf8' }),
    )
    if (config.compilerOptions) config.compilerOptions.incremental = false
  } catch {
    /* use default */
  }
  writeFileSync(dest, JSON.stringify(config, null, 2) + '\n')
  if (existsSync(join(ROOT, 'packages', pkg, 'tsconfig.build.json'))) {
    process.stderr.write(`restore-pi-tsconfig: ${pkg} (kept tsconfig.build.json)\n`)
  }
}

process.stderr.write('restore-pi-tsconfig: done\n')
