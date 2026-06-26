#!/usr/bin/env node
/**
 * Per-file test evaluation matrix for all source files.
 *
 * Usage:
 *   node scripts/audit-test-matrix.mjs
 *   node scripts/audit-test-matrix.mjs --json
 *   node scripts/audit-test-matrix.mjs --strict
 *   node scripts/audit-test-matrix.mjs --write-report
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatrix, strictMatrixFailures } from './lib/test-audit-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const args = new Set(process.argv.slice(2));
const jsonOut = args.has('--json');
const strict = args.has('--strict');
const writeReport = args.has('--write-report');

function groupCounts(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, { total: 0, untested: 0, critical: 0 });
    const g = groups.get(key);
    g.total++;
    if (row.status === 'untested') g.untested++;
    if (row.status === 'untested' && row.risk === 'critical') g.critical++;
  }
  return [...groups.entries()]
    .map(([key, stats]) => ({ key, ...stats }))
    .sort((a, b) => b.untested - a.untested || b.critical - a.critical);
}

function renderMarkdown(report) {
  const s = report.summary;
  const areaGroups = groupCounts(report.rows, (r) => r.area).slice(0, 20);
  const criticalGaps = report.rows
    .filter((r) => r.status === 'untested' && (r.risk === 'critical' || r.risk === 'high'))
    .slice(0, 40);

  let md = `# Test Evaluation Report\n\n`;
  md += `Generated: ${report.generatedAt}\n\n`;
  md += `## Summary\n\n`;
  md += `| Metric | Count |\n|--------|------:|\n`;
  md += `| Source files | ${s.totalSourceFiles} |\n`;
  md += `| Covered (named test) | ${s.covered} |\n`;
  md += `| Indirect (stem/other-name/suite tests) | ${s.indirect} |\n`;
  md += `| Untested | ${s.untested} |\n`;
  md += `| Unwired | ${s.unwired} |\n`;
  md += `| Critical untested | ${s.criticalUntested} |\n`;
  md += `| High untested | ${s.highUntested} |\n\n`;

  md += `## Untested by area (top 20)\n\n`;
  md += `| Area | Untested / Total | Critical untested |\n|------|----------------:|------------------:|\n`;
  for (const g of areaGroups) {
    md += `| ${g.key} | ${g.untested} / ${g.total} | ${g.critical} |\n`;
  }

  md += `\n## Priority gaps (critical/high untested)\n\n`;
  for (const row of criticalGaps) {
    md += `- \`${row.path}\` (${row.risk})\n`;
  }

  if (report.unwiredTests.length > 0) {
    md += `\n## Unwired test files\n\n`;
    for (const t of report.unwiredTests) {
      md += `- \`${t}\`\n`;
    }
  }

  md += `\nRegenerate: \`npm run audit:test-matrix -- --write-report\`\n`;
  return md;
}

function printHuman(report) {
  const s = report.summary;
  process.stdout.write('Test evaluation matrix\n');
  process.stdout.write('======================\n\n');
  process.stdout.write(`Source files: ${s.totalSourceFiles}\n`);
  process.stdout.write(`  covered: ${s.covered}, indirect: ${s.indirect}, untested: ${s.untested}, unwired: ${s.unwired}\n`);
  process.stdout.write(`  critical untested: ${s.criticalUntested}, high untested: ${s.highUntested}\n\n`);

  process.stdout.write('Top untested areas\n');
  for (const g of groupCounts(report.rows, (r) => r.area).slice(0, 12)) {
    process.stdout.write(`  ${g.key}: ${g.untested}/${g.total} untested (${g.critical} critical)\n`);
  }
  process.stdout.write('\n');

  if (report.unwiredTests.length > 0) {
    process.stdout.write(`Unwired test files (${report.unwiredTests.length})\n`);
    for (const t of report.unwiredTests.slice(0, 10)) {
      process.stdout.write(`  ${t}\n`);
    }
    if (report.unwiredTests.length > 10) {
      process.stdout.write(`  ... +${report.unwiredTests.length - 10} more\n`);
    }
    process.stdout.write('\n');
  }

  const failures = strictMatrixFailures(report);
  if (strict) {
    if (failures.length === 0) {
      process.stdout.write('Strict matrix: pass ✓\n');
    } else {
      process.stdout.write('Strict matrix failures:\n');
      for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
    }
  }

  process.stdout.write('\nFull JSON: npm run audit:test-matrix -- --json\n');
  process.stdout.write('Report doc: npm run audit:test-matrix -- --write-report\n');
}

function main() {
  const report = buildMatrix(ROOT);
  if (writeReport) {
    const md = renderMarkdown(report);
    writeFileSync(join(ROOT, 'docs/dev/test-evaluation-report.md'), md, 'utf8');
    process.stderr.write('Wrote docs/dev/test-evaluation-report.md\n');
  }
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  if (strict && strictMatrixFailures(report).length > 0) {
    process.exit(1);
  }
}

main();
