#!/usr/bin/env node
/**
 * Merge c8 lcov outputs and emit per-file coverage index.
 *
 * Usage: node scripts/merge-coverage-reports.mjs
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const COVERAGE_DIR = join(ROOT, 'coverage');

function parseLcov(content) {
  const files = [];
  let current = null;
  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      current = {
        file: line.slice(3).trim(),
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('LF:')) current.linesFound = Number(line.slice(3));
    else if (line.startsWith('LH:')) current.linesHit = Number(line.slice(3));
    else if (line.startsWith('BRF:')) current.branchesFound = Number(line.slice(4));
    else if (line.startsWith('BRH:')) current.branchesHit = Number(line.slice(4));
    else if (line === 'end_of_record') {
      files.push(current);
      current = null;
    }
  }
  return files;
}

function pct(hit, found) {
  if (found === 0) return 100;
  return Math.round((hit / found) * 1000) / 10;
}

function main() {
  if (!existsSync(COVERAGE_DIR)) {
    process.stderr.write('No coverage/ directory found. Run test:coverage:full first.\n');
    process.exit(1);
  }

  const lcovFiles = [];
  function collectLcov(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectLcov(full);
      else if (entry.name === 'lcov.info') lcovFiles.push(full);
    }
  }
  collectLcov(COVERAGE_DIR);

  const merged = new Map();
  for (const file of lcovFiles) {
    const entries = parseLcov(readFileSync(file, 'utf8'));
    for (const entry of entries) {
      const key = entry.file.replace(/\\/g, '/');
      const prev = merged.get(key) ?? {
        file: key,
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };
      prev.linesFound += entry.linesFound;
      prev.linesHit += entry.linesHit;
      prev.branchesFound += entry.branchesFound;
      prev.branchesHit += entry.branchesHit;
      merged.set(key, prev);
    }
  }

  const fileIndex = [...merged.values()]
    .map((entry) => ({
      file: entry.file,
      lines: { hit: entry.linesHit, found: entry.linesFound, pct: pct(entry.linesHit, entry.linesFound) },
      branches: { hit: entry.branchesHit, found: entry.branchesFound, pct: pct(entry.branchesHit, entry.branchesFound) },
    }))
    .sort((a, b) => a.lines.pct - b.lines.pct || a.file.localeCompare(b.file));

  mkdirSync(COVERAGE_DIR, { recursive: true });
  writeFileSync(join(COVERAGE_DIR, 'file-index.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    files: fileIndex,
  }, null, 2)}\n`, 'utf8');

  const mergedLcov = lcovFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  writeFileSync(join(COVERAGE_DIR, 'lcov.info'), mergedLcov, 'utf8');

  process.stdout.write(`Merged ${fileIndex.length} files into coverage/file-index.json\n`);
}

main();
