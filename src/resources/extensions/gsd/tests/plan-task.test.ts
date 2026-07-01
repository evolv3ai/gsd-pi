import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getSlice, getTask, getSliceTasks, getGateResults } from '../gsd-db.ts';
import { handlePlanTask } from '../tools/plan-task.ts';
import { parseTaskPlanFile } from '../files.ts';

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-plan-task-'));
  mkdirSync(join(base, '.gsd', 'phases', '01-test'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seedParent(): void {
  insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.' });
}

function validParams() {
  return {
    milestoneId: 'M001',
    sliceId: 'S02',
    taskId: 'T02',
    title: 'Write task handler',
    description: 'Implement the DB-backed task planning handler.',
    estimate: '30m',
    files: ['src/resources/extensions/gsd/tools/plan-task.ts'],
    verify: 'node --test src/resources/extensions/gsd/tests/plan-task.test.ts',
    inputs: ['src/resources/extensions/gsd/tools/plan-task.ts'],
    expectedOutput: ['src/resources/extensions/gsd/tests/plan-task.test.ts'],
    observabilityImpact: 'Tests exercise validation, render failure, and cache refresh behavior.',
  };
}

test('handlePlanTask writes planning state and renders task plan', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const task = getTask('M001', 'S02', 'T02');
    assert.ok(task);
    assert.equal(task?.title, 'Write task handler');
    assert.equal(task?.description, 'Implement the DB-backed task planning handler.');
    assert.equal(task?.estimate, '30m');

    const taskPlanPath = join(base, '.gsd', 'phases', '01-test', 'T02-PLAN.md');
    assert.ok(existsSync(taskPlanPath), 'task plan should be rendered to disk');
    const taskPlan = parseTaskPlanFile(readFileSync(taskPlanPath, 'utf-8'));
    assert.equal(taskPlan.frontmatter.estimated_files, 1);
    assert.deepEqual(taskPlan.frontmatter.skills_used, []);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask seeds execute-task gate rows for incremental planning', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const gateIds = getGateResults('M001', 'S02', 'task')
      .filter((gate) => gate.task_id === 'T02')
      .map((gate) => gate.gate_id)
      .sort();
    assert.deepEqual(gateIds, ['Q5', 'Q6', 'Q7']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects invalid payloads', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({ ...validParams(), files: [''] }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: files must contain only non-empty strings/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask explains string IO fields must be arrays', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      expectedOutput: 'src/output.ts' as unknown as string[],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: expectedOutput must be an array of strings, not string/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects prose expectedOutput entries', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      expectedOutput: ['Browser UI supports due-date add/edit flows and mixed-list urgency rendering.'],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: expectedOutput must contain only file paths/);
    assert.doesNotMatch(result.error, /outside allowed repository roots/);
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'invalid output contract must not persist the task');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects absolute task IO paths outside the active worktree', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const outside = join(tmpdir(), 'outside-checkout', 'index.html');
    const result = await handlePlanTask({
      ...validParams(),
      inputs: [outside],
      expectedOutput: [outside],
    }, base);

    assert.ok('error' in result);
    assert.match(result.error, /validation failed: inputs contains path outside allowed repository roots/);
    assert.equal(getTask('M001', 'S02', 'T02'), null, 'invalid planning IO must not persist the task');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects missing parent slice', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    const result = await handlePlanTask(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /missing parent slice: M001\/S02/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask surfaces render failures without changing parse-visible task plan state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    insertTask({ id: 'T02', sliceId: 'S02', milestoneId: 'M001', title: 'Cached task', status: 'pending' });
    const taskPlanPath = join(base, '.gsd', 'phases', '01-test', 'T02-PLAN.md');
    writeFileSync(taskPlanPath, '---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# T02: Cached task\n', 'utf-8');
    rmSync(taskPlanPath, { force: true });
    mkdirSync(taskPlanPath, { recursive: true });

    const result = await handlePlanTask(validParams(), base);
    assert.ok('error' in result);
    assert.match(result.error, /render failed:/);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask keeps the sketch flag set when the flat-phase slice plan sync fails (#1083)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Planning slice', status: 'pending', demo: 'Rendered plans exist.', isSketch: true });

    // The per-task render writes T02-PLAN.md and succeeds, but the flat-phase
    // slice re-render (the canonical PLAN.md that embeds task checkboxes) targets
    // phases/01-test/01-02-PLAN.md. Pre-creating that path as a directory forces
    // EISDIR on the slice sync, so the canonical slice plan never reflects the
    // task. The sketch flag must therefore stay set — the slice keeps refining —
    // instead of leaving the slice out of refining over a stale plan.
    mkdirSync(join(base, '.gsd', 'phases', '01-test', '01-02-PLAN.md'), { recursive: true });

    const result = await handlePlanTask(validParams(), base);
    assert.equal(getSlice('M001', 'S02')?.is_sketch, 1, 'sketch flag must stay set when the canonical slice plan could not sync');
    assert.ok(getTask('M001', 'S02', 'T02'), 'the task itself is still persisted so the slice can re-sync on retry');
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask reruns idempotently and refreshes parse-visible state', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const taskPlanPath = join(base, '.gsd', 'phases', '01-test', 'T02-PLAN.md');
    writeFileSync(taskPlanPath, '---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# T02: Cached task\n', 'utf-8');

    const first = await handlePlanTask(validParams(), base);
    assert.ok(!('error' in first));

    const second = await handlePlanTask({
      ...validParams(),
      description: 'Updated task handler description.',
      estimate: '1h',
    }, base);
    assert.ok(!('error' in second));

    const task = getTask('M001', 'S02', 'T02');
    assert.equal(task?.description, 'Updated task handler description.');
    assert.equal(task?.estimate, '1h');

    const parsed = parseTaskPlanFile(readFileSync(taskPlanPath, 'utf-8'));
    assert.equal(parsed.frontmatter.estimated_steps, 1);
    assert.match(readFileSync(taskPlanPath, 'utf-8'), /Updated task handler description\./);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask persists targetRepositories for parent-workspace tasks', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      targetRepositories: ['project'],
    }, base);
    assert.ok(!('error' in result), `unexpected error: ${'error' in result ? result.error : ''}`);

    const tasks = getSliceTasks('M001', 'S02');
    const planned = tasks.find((t) => t.id === 'T02');
    assert.ok(planned, 'planned task should exist');
    assert.deepEqual(planned?.target_repositories, ['project']);
  } finally {
    cleanup(base);
  }
});

test('handlePlanTask rejects non-array targetRepositories', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, '.gsd', 'gsd.db'));

  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      targetRepositories: 'frontend' as unknown as string[],
    }, base);
    assert.ok('error' in result);
    assert.match(result.error, /validation failed: targetRepositories/);
  } finally {
    cleanup(base);
  }
});
