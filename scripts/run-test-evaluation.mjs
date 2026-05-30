#!/usr/bin/env node
/**
 * Run all test evaluation tiers and emit test-evaluation-results.json.
 *
 * Usage:
 *   node scripts/run-test-evaluation.mjs
 *   node scripts/run-test-evaluation.mjs --full
 *   node scripts/run-test-evaluation.mjs --skip-build
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const full = args.has('--full');

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runTier(name, command, env = {}) {
  const start = Date.now();
  process.stderr.write(`\n── ${name} ──\n`);
  const result = spawnSync(getNpmCommand(), ['run', command], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const durationMs = Date.now() - start;
  const status = result.status ?? 1;
  return {
    name,
    command: `npm run ${command}`,
    status,
    pass: status === 0,
    durationMs,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
  };
}

function runShellTier(name, shellCommand, env = {}) {
  const start = Date.now();
  process.stderr.write(`\n── ${name} ──\n`);
  const result = spawnSync(shellCommand, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const durationMs = Date.now() - start;
  const status = result.status ?? 1;
  return {
    name,
    command: shellCommand,
    status,
    pass: status === 0,
    durationMs,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
  };
}

function main() {
  const tiers = [
    runTier('verify:fast', 'verify:fast'),
    runTier('test:unit', 'test:unit'),
    runTier('test:packages', 'test:packages'),
    runTier('test:integration', 'test:integration'),
    runShellTier(
      'test:e2e',
      'chmod +x dist/loader.js 2>/dev/null || true; GSD_SMOKE_BINARY="$PWD/dist/loader.js" npm run test:e2e',
    ),
  ];

  const auxiliary = [
    runTier('test:browser-tools', 'test:browser-tools'),
    runTier('test:secret-scan', 'test:secret-scan'),
    runTier('test:smoke', 'test:smoke'),
  ];

  if (full) {
    tiers.push(runTier('verify:merge', 'verify:merge'));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    full,
    blocking: tiers,
    auxiliary,
    summary: {
      blockingPass: tiers.every((t) => t.pass),
      auxiliaryPass: auxiliary.every((t) => t.pass),
      totalDurationMs: [...tiers, ...auxiliary].reduce((sum, t) => sum + t.durationMs, 0),
    },
  };

  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  const outPath = join(ROOT, 'test-results/test-evaluation-results.json');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write('\nTest evaluation summary\n');
  process.stdout.write(`  blocking pass: ${report.summary.blockingPass}\n`);
  process.stdout.write(`  auxiliary pass: ${report.summary.auxiliaryPass}\n`);
  process.stdout.write(`  wrote ${outPath}\n`);

  for (const tier of [...tiers, ...auxiliary]) {
    const mark = tier.pass ? '✓' : '✗';
    process.stdout.write(`  ${mark} ${tier.name} (${(tier.durationMs / 1000).toFixed(1)}s)\n`);
  }

  if (!report.summary.blockingPass) {
    process.exit(1);
  }
}

main();
