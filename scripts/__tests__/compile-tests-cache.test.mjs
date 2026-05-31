// Project/App: gsd-pi
// File Purpose: Unit tests for stale-aware dist-test compile cache decisions.

import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCompileFingerprint,
  ensureDistTestNodeModules,
  isCompileCacheFresh,
} from '../compile-tests.mjs';

test('buildCompileFingerprint is stable across input ordering', () => {
  const entries = [
    { path: 'src/b.ts', size: 20, mtimeMs: 2000.8 },
    { path: 'src/a.ts', size: 10, mtimeMs: 1000.2 },
  ];
  const reversed = entries.slice().reverse();

  assert.deepEqual(buildCompileFingerprint(entries), buildCompileFingerprint(reversed));
});

test('buildCompileFingerprint changes when source metadata changes', () => {
  const before = buildCompileFingerprint([
    { path: 'src/a.ts', size: 10, mtimeMs: 1000 },
  ]);
  const after = buildCompileFingerprint([
    { path: 'src/a.ts', size: 11, mtimeMs: 1000 },
  ]);

  assert.notEqual(after.hash, before.hash);
  assert.equal(after.fileCount, 1);
  assert.equal(after.bytes, 11);
});

test('isCompileCacheFresh requires dist-test and matching schema/hash', () => {
  const fingerprint = buildCompileFingerprint([
    { path: 'src/a.ts', size: 10, mtimeMs: 1000 },
  ]);

  assert.equal(isCompileCacheFresh({ ...fingerprint }, fingerprint, true), true);
  assert.equal(isCompileCacheFresh({ ...fingerprint }, fingerprint, false), false);
  assert.equal(isCompileCacheFresh({ ...fingerprint, schemaVersion: 0 }, fingerprint, true), false);
  assert.equal(isCompileCacheFresh({ ...fingerprint, hash: 'different' }, fingerprint, true), false);
  assert.equal(isCompileCacheFresh(null, fingerprint, true), false);
});

test('ensureDistTestNodeModules replaces stale node_modules directories', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'gsd-compile-tests-'));
  try {
    const root = join(workspace, 'root');
    const distTestDir = join(workspace, 'dist-test');
    const stalePackage = join(distTestDir, 'node_modules', 'chalk', 'package.json');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(distTestDir, 'node_modules', 'chalk'), { recursive: true });
    writeFileSync(stalePackage, '{"name":"chalk"}\n');

    const replaced = await ensureDistTestNodeModules(root, distTestDir);
    const nodeModules = join(distTestDir, 'node_modules');

    assert.equal(replaced, true);
    assert.equal(lstatSync(nodeModules).isSymbolicLink(), true);
    assert.equal(existsSync(stalePackage), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
