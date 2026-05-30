#!/usr/bin/env node
/**
 * Deep test gap audit: unwired tests, untested extensions, thin packages, orphan suites.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMatrix,
  collectTestFiles,
  classifyRunner,
  isInNpmTest,
  isReachableTest,
  getLinkablePackages,
  strictUnwiredFailures,
  auditExtensionsFromTests,
  auditPackagesFromRoot,
} from './lib/test-audit-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const args = new Set(process.argv.slice(2));
const jsonOut = args.has('--json');
const strictUnwired = args.has('--strict-unwired');

function auditExtensions(allTests) {
  const extRoot = join(ROOT, 'src/resources/extensions');
  return auditExtensionsFromTests(extRoot, allTests);
}

function auditPackages() {
  return auditPackagesFromRoot(ROOT, getLinkablePackages);
}

function buildReport() {
  const matrix = buildMatrix(ROOT);
  const allTests = matrix.allTests;
  const byRunner = {};
  for (const testPath of allTests) {
    const runner = classifyRunner(testPath);
    (byRunner[runner] ??= []).push(testPath);
  }

  const extensions = auditExtensions(allTests);
  const packages = auditPackages();
  const pkgScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};

  return {
    generatedAt: matrix.generatedAt,
    summary: {
      ...matrix.summary,
      totalTestFiles: allTests.length,
      inNpmTest: allTests.filter((t) => isInNpmTest(classifyRunner(t))).length,
      notInNpmTest: allTests.filter((t) => !isInNpmTest(classifyRunner(t))).length,
      unwiredTests: matrix.unwiredTests.length,
      orphanScriptTests: (byRunner['scripts-fast-gates'] ?? []).length,
      extensionsNoTests: extensions.filter((e) => e.tests === 0).length,
      extensionsUnwired: extensions.filter((e) => e.tests > 0 && !e.wired).length,
      thinPackages: packages.filter((p) => p.srcCount > 0 && (p.ratio ?? 0) < 0.4).length,
    },
    critical: {
      unwiredTests: matrix.unwiredTests,
      orphanScriptTests: byRunner['scripts-fast-gates'] ?? [],
      extensionsNoTests: extensions.filter((e) => e.tests === 0),
      extensionsUnwired: extensions.filter((e) => e.tests > 0 && !e.wired),
      thinPackages: packages.filter((p) => p.srcCount > 0 && (p.ratio ?? 0) < 0.4),
    },
    byRunner: Object.fromEntries(
      Object.entries(byRunner)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, v]) => [k, { count: v.length, files: v }]),
    ),
    auxiliaryTestScripts: Object.entries(pkgScripts)
      .filter(([key]) => key.startsWith('test:') && ![
        'test:compile', 'test:unit', 'test:unit:compiled', 'test:integration',
        'test:packages', 'test:packages:compiled',
      ].includes(key))
      .map(([name, command]) => ({ name, command })),
    extensions,
    packages,
    unreachableTests: allTests.filter((t) => !isReachableTest(classifyRunner(t)) && classifyRunner(t) !== 'unknown'),
  };
}

function printHuman(report) {
  const s = report.summary;
  process.stdout.write('Test gap audit\n');
  process.stdout.write('==============\n\n');
  process.stdout.write(`Total test files: ${s.totalTestFiles}\n`);
  process.stdout.write(`In default npm test: ${s.inNpmTest}\n`);
  process.stdout.write(`Not in default npm test: ${s.notInNpmTest}\n\n`);

  process.stdout.write('CRITICAL — unwired tests\n');
  if (report.critical.unwiredTests.length === 0) {
    process.stdout.write('  None detected ✓\n');
  } else {
    for (const f of report.critical.unwiredTests) process.stdout.write(`  ✗ ${f}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write('Extensions with zero tests\n');
  for (const e of report.critical.extensionsNoTests) {
    process.stdout.write(`  ✗ ${e.name} (${e.sources} source files)\n`);
  }
  if (report.critical.extensionsNoTests.length === 0) process.stdout.write('  None ✓\n');
  process.stdout.write('\n');

  process.stdout.write('Thin packages (<40% test/source)\n');
  for (const p of report.critical.thinPackages) {
    const pct = p.ratio == null ? 'n/a' : `${(p.ratio * 100).toFixed(0)}%`;
    process.stdout.write(`  ⚠ ${p.package}: ${p.testCount}/${p.srcCount} (${pct})\n`);
  }
  if (report.critical.thinPackages.length === 0) process.stdout.write('  None ✓\n');
}

function main() {
  const report = buildReport();
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  if (strictUnwired) {
    const failures = strictUnwiredFailures(collectTestFiles(ROOT));
    if (failures.length > 0) {
      process.stderr.write(`\nERROR: ${failures.length} unwired/unknown test file(s):\n`);
      for (const f of failures) process.stderr.write(`  ${f}\n`);
      process.exit(1);
    }
  }
}

main();
