// GSD Extension - Auto-migration gate tests (plan 026).
// Covers needsAutoMigration's trigger (empty milestones table + .gsd/milestones
// present) and validateMigration's engine-vs-markdown count comparison.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase, insertMilestone, insertSlice } from '../gsd-db.ts';
import { needsAutoMigration, validateMigration } from '../workflow-migration.ts';

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-migration-gates-'));
}

function openProjectDb(base: string): string {
  const gsdDir = join(base, '.gsd');
  mkdirSync(gsdDir, { recursive: true });
  const dbPath = join(gsdDir, 'gsd.db');
  assert.ok(openDatabase(dbPath), 'openDatabase should succeed');
  return dbPath;
}

function cleanup(base: string): void {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

function writeRoadmap(base: string, mId: string, sliceLines: string[]): void {
  const mDir = join(base, '.gsd', 'milestones', mId);
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(mDir, 'ROADMAP.md'), [
    `# ${mId}: Test`,
    '',
    '## Slices',
    '',
    ...sliceLines,
    '',
  ].join('\n'));
}

describe('needsAutoMigration', () => {
  test('false for a fresh project with no legacy markdown', () => {
    const base = makeProject();
    try {
      openProjectDb(base);
      assert.equal(needsAutoMigration(base), false, 'no .gsd/milestones dir → no migration');
    } finally {
      cleanup(base);
    }
  });

  test('true when engine tables are empty and .gsd/milestones exists', () => {
    const base = makeProject();
    try {
      openProjectDb(base);
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      assert.equal(needsAutoMigration(base), true, 'legacy markdown + empty engine → migrate');
    } finally {
      cleanup(base);
    }
  });

  test('false once the milestones table has rows (migration already done)', () => {
    const base = makeProject();
    try {
      openProjectDb(base);
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      insertMilestone({ id: 'M001', title: 'Migrated' });
      assert.equal(needsAutoMigration(base), false, 'engine rows present → migration already done');
    } finally {
      cleanup(base);
    }
  });

  test('false when no database connection is open', () => {
    const base = makeProject();
    try {
      mkdirSync(join(base, '.gsd', 'milestones', 'M001'), { recursive: true });
      closeDatabase();
      assert.equal(needsAutoMigration(base), false, 'no DB → cannot migrate');
    } finally {
      cleanup(base);
    }
  });
});

describe('validateMigration', () => {
  test('reports no discrepancies when engine counts match markdown', () => {
    const base = makeProject();
    try {
      openProjectDb(base);
      writeRoadmap(base, 'M001', ['- [ ] **S01: Test Slice** `risk:low` `depends:[]`']);
      insertMilestone({ id: 'M001', title: 'Test' });
      insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

      const result = validateMigration(base);
      assert.deepEqual(result.discrepancies, [], 'matching engine/markdown counts → clean');
    } finally {
      cleanup(base);
    }
  });

  test('reports discrepancies when engine counts diverge from markdown', () => {
    const base = makeProject();
    try {
      openProjectDb(base);
      writeRoadmap(base, 'M001', [
        '- [ ] **S01: Test Slice** `risk:low` `depends:[]`',
        '- [ ] **S02: Second Slice** `risk:low` `depends:[]`',
      ]);
      // Engine has no rows at all → milestone and slice counts both diverge.
      const result = validateMigration(base);
      assert.ok(
        result.discrepancies.some((d) => d.includes('Milestone count mismatch')),
        `expected milestone mismatch, got: ${result.discrepancies.join('; ')}`,
      );
      assert.ok(
        result.discrepancies.some((d) => d.includes('Slice count mismatch')),
        `expected slice mismatch, got: ${result.discrepancies.join('; ')}`,
      );
    } finally {
      cleanup(base);
    }
  });

  test('reports a validation failure when no database connection is open', () => {
    const base = makeProject();
    try {
      closeDatabase();
      const result = validateMigration(base);
      assert.deepEqual(result.discrepancies, ['No database connection for validation']);
    } finally {
      cleanup(base);
    }
  });
});
