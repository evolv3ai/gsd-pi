import { createTestContext } from './test-helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  type ReworkBriefFindingInput,
} from '../gsd-db.ts';
import { handleReworkBriefSave } from '../tools/rework-brief.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rework-brief-'));
  return path.join(dir, 'test.db');
}

function cleanup(dbPath: string): void {
  closeDatabase();
  try {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  } catch {
    // best effort
  }
}

function finding(overrides: Partial<ReworkBriefFindingInput> = {}): ReworkBriefFindingInput {
  return {
    findingId: 'F1',
    severity: 'blocking',
    description: 'Compile regression',
    requiredFix: 'Fix compile error',
    verificationCommands: ['pnpm run typecheck:extensions'],
    ...overrides,
  };
}

const baseParams = {
  briefId: 'RB-001',
  milestoneId: 'M001',
  sliceId: 'S01',
  taskId: 'T01',
};

function findingRow(): { status: string; evidence: string; decision_ref: string } | undefined {
  return _getAdapter()!
    .prepare("SELECT status, evidence, decision_ref FROM rework_brief_findings WHERE brief_id = 'RB-001' AND finding_id = 'F1'")
    .get() as { status: string; evidence: string; decision_ref: string } | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// rework-brief: a blocking finding saved as non-pending must carry the same
// justification a reworkResolution would, otherwise it bypasses the
// gsd_task_complete blocking gate (which only sees `pending` rows).
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== rework-brief: rejects blocking resolved finding without evidence ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const result = await handleReworkBriefSave({
    ...baseParams,
    findings: [finding({ status: 'resolved' })],
  });

  assertTrue('error' in result, 'blocking resolved finding without evidence should be rejected');
  if ('error' in result) {
    assertMatch(result.error, /evidence is required/i, 'error should mention the evidence requirement');
  }
  const rows = _getAdapter()!.prepare('SELECT COUNT(*) AS n FROM rework_brief_findings').get() as { n: number };
  assertEq(rows.n, 0, 'no finding rows should be persisted when validation fails');

  cleanup(dbPath);
}

console.log('\n=== rework-brief: rejects blocking deferred-with-override without decisionRef ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const result = await handleReworkBriefSave({
    ...baseParams,
    findings: [finding({ status: 'deferred-with-override', evidence: 'Maintainer accepted temporary deferral.' })],
  });

  assertTrue('error' in result, 'deferred-with-override without decisionRef should be rejected');
  if ('error' in result) {
    assertMatch(result.error, /decisionRef is required/i, 'error should mention the decisionRef requirement');
  }

  cleanup(dbPath);
}

console.log('\n=== rework-brief: rejects invalid finding status ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const result = await handleReworkBriefSave({
    ...baseParams,
    findings: [finding({ status: 'bogus' as unknown as ReworkBriefFindingInput['status'] })],
  });

  assertTrue('error' in result, 'an unknown status value should be rejected');
  if ('error' in result) {
    assertMatch(result.error, /status must be/i, 'error should name the allowed statuses');
  }

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// rework-brief: legitimate saves still succeed.
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== rework-brief: blocking finding defaults to pending ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const result = await handleReworkBriefSave({
    ...baseParams,
    findings: [finding()],
  });

  assertTrue(!('error' in result), 'a blocking finding without a status should be accepted');
  assertEq(findingRow()?.status, 'pending', 'finding without status should default to pending');

  cleanup(dbPath);
}

console.log('\n=== rework-brief: accepts blocking resolved finding with evidence ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const result = await handleReworkBriefSave({
    ...baseParams,
    findings: [finding({ status: 'resolved', evidence: 'Fixed compile error and reran pnpm run typecheck:extensions.' })],
  });

  assertTrue(!('error' in result), 'a resolved blocking finding with evidence should be accepted');
  assertEq(findingRow()?.status, 'resolved', 'finding should persist as resolved when evidence is supplied');
  assertMatch(findingRow()?.evidence ?? '', /Fixed compile error/, 'resolution evidence should be persisted');

  cleanup(dbPath);
}

console.log('\n=== rework-brief: accepts blocking deferred-with-override with evidence and decisionRef ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const result = await handleReworkBriefSave({
    ...baseParams,
    findings: [finding({
      status: 'deferred-with-override',
      evidence: 'Maintainer accepted temporary deferral.',
      decisionRef: 'DEC-2026-07-07-rework-deferral',
    })],
  });

  assertTrue(!('error' in result), 'a deferred-with-override finding with evidence and decisionRef should be accepted');
  assertEq(findingRow()?.status, 'deferred-with-override', 'finding should persist the override status');
  assertEq(findingRow()?.decision_ref, 'DEC-2026-07-07-rework-deferral', 'decision reference should be persisted');

  cleanup(dbPath);
}

console.log('\n=== rework-brief: advisory resolved finding does not require evidence ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Advisory findings never gate gsd_task_complete, so pre-resolving one
  // without evidence is harmless and stays permitted.
  const result = await handleReworkBriefSave({
    ...baseParams,
    findings: [finding({ severity: 'advisory', status: 'resolved' })],
  });

  assertTrue(!('error' in result), 'an advisory resolved finding should be accepted without evidence');
  assertEq(findingRow()?.status, 'resolved', 'advisory finding status should be preserved');

  cleanup(dbPath);
}

report();
