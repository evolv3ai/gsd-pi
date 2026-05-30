#!/usr/bin/env node
// gsd-pi + scripts/verify-extension-coverage.cjs — extensions with >=5 source files must have tests
'use strict';

const { readdirSync, existsSync, statSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const EXT_ROOT = join(ROOT, 'src/resources/extensions');
const SRC_RE = /\.(?:ts|tsx|mjs|js)$/;
const TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mjs|js|cjs)$/;

function countFiles(dir, pred) {
  let count = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full, pred);
    else if (pred(entry.name)) count++;
  }
  return count;
}

function main() {
  const failures = [];
  for (const entry of readdirSync(EXT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const extDir = join(EXT_ROOT, entry.name);
    const sources = countFiles(extDir, (name) => SRC_RE.test(name) && !name.endsWith('.d.ts') && !TEST_RE.test(name));
    const tests = countFiles(extDir, (name) => TEST_RE.test(name));
    if (sources >= 5 && tests === 0) {
      failures.push({ name: entry.name, sources, tests });
    }
  }

  if (failures.length === 0) {
    process.stderr.write('All extensions with >=5 source files have tests.\n');
    process.exit(0);
  }

  process.stderr.write(`ERROR: ${failures.length} extension(s) missing required tests:\n`);
  for (const f of failures) {
    process.stderr.write(`  ${f.name}: ${f.sources} source files, 0 tests\n`);
  }
  process.exit(1);
}

main();
