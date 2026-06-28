// tool-call-loop-guard — Tests for the tool-call loop detection guard.
//
// Verifies that identical consecutive tool calls are detected and blocked
// after exceeding the threshold, and that the guard resets properly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkToolCallLoop,
  resetToolCallLoopGuard,
  disableToolCallLoopGuard,
  getToolCallLoopCount,
  getToolCallCountForTool,
} from '../bootstrap/tool-call-loop-guard.ts';


// ═══════════════════════════════════════════════════════════════════════════
// Allows first N calls, blocks after threshold
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: blocks after threshold ──');

{
  resetToolCallLoopGuard();

  // First 4 identical calls should be allowed (threshold is 4)
  for (let i = 1; i <= 4; i++) {
    const result = checkToolCallLoop('web_search', { query: 'same query' });
    assert.ok(result.block === false, `Call ${i} should be allowed`);
    assert.deepStrictEqual(result.count, i, `Count should be ${i} after call ${i}`);
  }

  // 5th identical call should be blocked
  const blocked = checkToolCallLoop('web_search', { query: 'same query' });
  assert.ok(blocked.block === true, '5th identical call should be blocked');
  assert.ok(blocked.reason!.includes('web_search'), 'Reason should mention tool name');
  assert.ok(blocked.reason!.includes('5'), 'Reason should mention count');
}

// ═══════════════════════════════════════════════════════════════════════════
// Different tool calls reset the streak
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: different calls reset streak ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query A' });
  assert.deepStrictEqual(getToolCallLoopCount(), 3, 'Count should be 3 after 3 identical calls');

  // A different call resets the streak
  const different = checkToolCallLoop('bash', { command: 'ls' });
  assert.ok(different.block === false, 'Different tool call should be allowed');
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Count should reset to 1 after different call');

  // Same tool but different args also resets
  checkToolCallLoop('web_search', { query: 'query A' });
  checkToolCallLoop('web_search', { query: 'query B' }); // different args
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Different args should reset count');
}

// ═══════════════════════════════════════════════════════════════════════════
// Reset clears the guard
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: reset clears state ──');

{
  resetToolCallLoopGuard();
  checkToolCallLoop('web_search', { query: 'q' });
  checkToolCallLoop('web_search', { query: 'q' });
  checkToolCallLoop('web_search', { query: 'q' });
  assert.deepStrictEqual(getToolCallLoopCount(), 3, 'Count should be 3 before reset');

  resetToolCallLoopGuard();
  assert.deepStrictEqual(getToolCallLoopCount(), 0, 'Count should be 0 after reset');

  // After reset, the same call starts fresh
  const result = checkToolCallLoop('web_search', { query: 'q' });
  assert.ok(result.block === false, 'Call after reset should be allowed');
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Count should be 1 after first call post-reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Disable makes guard permissive
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: disable allows everything ──');

{
  disableToolCallLoopGuard();

  for (let i = 0; i < 10; i++) {
    const result = checkToolCallLoop('web_search', { query: 'same' });
    assert.ok(result.block === false, `Call ${i + 1} should be allowed when disabled`);
  }

  // Re-enable via reset
  resetToolCallLoopGuard();
  checkToolCallLoop('web_search', { query: 'q' });
  assert.deepStrictEqual(getToolCallLoopCount(), 1, 'Guard should be active again after reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Arg order doesn't affect hash
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: arg order is normalized ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('web_search', { query: 'test', limit: 5 });
  const result = checkToolCallLoop('web_search', { limit: 5, query: 'test' }); // same args, different order
  assert.ok(result.block === false, 'Same args in different order should count as consecutive');
  assert.deepStrictEqual(getToolCallLoopCount(), 2, 'Should detect as same call regardless of key order');
}

// ═══════════════════════════════════════════════════════════════════════════
// Nested/array arguments produce distinct hashes
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: nested args are not stripped ──');

{
  resetToolCallLoopGuard();

  // Simulate ask_user_questions-style calls with different nested content
  for (let i = 1; i <= 5; i++) {
    const result = checkToolCallLoop('ask_user_questions', {
      questions: [{ id: `q${i}`, question: `Question ${i}?` }],
    });
    assert.ok(result.block === false, `Nested call ${i} with unique content should be allowed`);
    assert.deepStrictEqual(getToolCallLoopCount(), 1, `Each unique nested call should reset count to 1`);
  }

  // Truly identical nested calls should still be detected.
  // ask_user_questions has a strict threshold of 1, so the 2nd identical call is blocked.
  resetToolCallLoopGuard();
  const first = checkToolCallLoop('ask_user_questions', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(first.block === false, 'First ask_user_questions call should be allowed');
  const blocked = checkToolCallLoop('ask_user_questions', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(blocked.block === true, '2nd identical ask_user_questions call should be blocked (strict threshold)');

  // Non-strict tools still allow up to 4 identical calls
  resetToolCallLoopGuard();
  for (let i = 1; i <= 4; i++) {
    const r = checkToolCallLoop('web_search', {
      questions: [{ id: 'same', question: 'Same?' }],
    });
    assert.ok(r.block === false, `web_search call ${i} should be allowed (normal threshold)`);
  }
  const blockedNormal = checkToolCallLoop('web_search', {
    questions: [{ id: 'same', question: 'Same?' }],
  });
  assert.ok(blockedNormal.block === true, '5th identical web_search call should be blocked');
}

// ═══════════════════════════════════════════════════════════════════════════
// Nested object key order is normalized
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: nested key order is normalized ──');

{
  resetToolCallLoopGuard();

  checkToolCallLoop('tool', { outer: { b: 2, a: 1 } });
  const result = checkToolCallLoop('tool', { outer: { a: 1, b: 2 } });
  assert.deepStrictEqual(getToolCallLoopCount(), 2, 'Same nested args in different key order should match');
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-tool-name cap (#783 Brief C) — catches improvisation loops with varied args
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: per-tool cap blocks varied-args improvisation (#783) ──');

{
  resetToolCallLoopGuard();

  // A one-shot workflow tool called with DIFFERENT args each time (the reported
  // improvisation pattern). The identical-signature streak alone would reset
  // every call; the per-tool cap must catch it.
  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('gsd_complete_milestone', { milestone: `M${i}` });
    assert.ok(result.block === false, `one-shot call ${i} (varied args) should be allowed`);
    assert.deepStrictEqual(getToolCallCountForTool('gsd_complete_milestone'), i, `per-tool count should be ${i}`);
  }
  // 7th call (cap 6 + 1) must be blocked by the per-tool guard.
  const blocked = checkToolCallLoop('gsd_complete_milestone', { milestone: 'M7' });
  assert.ok(blocked.block === true, '7th one-shot call (varied args) should be blocked by per-tool cap');
  assert.ok(blocked.reason!.includes('repeated tool'), 'reason should identify the per-tool guard');
  assert.ok(blocked.reason!.includes('gsd_complete_milestone'), 'reason should name the tool');
  assert.ok(blocked.reason!.includes('7'), 'reason should mention the count');
}

// ═══════════════════════════════════════════════════════════════════════════
// Repeatable tools get the higher cap
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: repeatable tools get the higher cap (#783) ──');

{
  resetToolCallLoopGuard();

  // bash is repeatable: varied commands are legitimate up to the higher cap.
  for (let i = 1; i <= 15; i++) {
    const result = checkToolCallLoop('bash', { command: `echo ${i}` });
    assert.ok(result.block === false, `bash call ${i} (varied args) should be allowed`);
  }
  // 16th call (cap 15 + 1) is blocked by the per-tool guard — this is the
  // improvisation-through-bash case from the forensics (~51 calls).
  const blocked = checkToolCallLoop('bash', { command: 'echo 16' });
  assert.ok(blocked.block === true, '16th bash call (varied args) should be blocked by per-tool cap');
  assert.ok(blocked.reason!.includes('cap 15'), 'reason should mention the repeatable cap');
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-tool counts are independent per tool and reset together
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: per-tool counts are independent and reset together (#783) ──');

{
  resetToolCallLoopGuard();

  // Two different tools tracked separately.
  for (let i = 0; i < 3; i++) checkToolCallLoop('read', { path: `f${i}` });
  for (let i = 0; i < 3; i++) checkToolCallLoop('write', { path: `g${i}` });
  assert.deepStrictEqual(getToolCallCountForTool('read'), 3, 'read tracked separately');
  assert.deepStrictEqual(getToolCallCountForTool('write'), 3, 'write tracked separately');
  assert.deepStrictEqual(getToolCallCountForTool('edit'), 0, 'uncalled tool reports 0');

  resetToolCallLoopGuard();
  assert.deepStrictEqual(getToolCallCountForTool('read'), 0, 'per-tool counts cleared on reset');
  assert.deepStrictEqual(getToolCallCountForTool('write'), 0, 'per-tool counts cleared on reset');
}

// ═══════════════════════════════════════════════════════════════════════════
// Newly-repeatable tools from core-session-tools.ts get the higher cap.
// bg_shell, find, ls, search_and_read were added to INHERENTLY_REPEATABLE_TOOL_SET
// in the code-quality consolidation PR (previously only bash/read/write/etc).
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: new repeatable tools (bg_shell, find, ls, search_and_read) get high cap ──');

{
  for (const toolName of ['bg_shell', 'find', 'ls', 'search_and_read']) {
    resetToolCallLoopGuard();

    // Should allow up to 15 varied calls without blocking.
    for (let i = 1; i <= 15; i++) {
      const result = checkToolCallLoop(toolName, { arg: `v${i}` });
      assert.ok(result.block === false, `${toolName} call ${i} (varied args) should be allowed`);
    }
    // 16th call with varied args must be blocked by the per-tool repeatable cap.
    const blocked = checkToolCallLoop(toolName, { arg: 'v16' });
    assert.ok(blocked.block === true, `${toolName}: 16th call must be blocked by repeatable cap`);
    assert.ok(blocked.reason?.includes('cap 15'), `${toolName}: reason must mention cap 15`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Non-repeatable tools excluded from INHERENTLY_REPEATABLE_TOOL_SET use the
// default cap (6), not the repeatable cap (15).
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Loop guard: ToolSearch (excluded from repeatable set) hits default cap ──');

{
  // ToolSearch is in MINIMAL_AUTO_BASE but explicitly excluded from repeatable.
  // It should hit the default cap of 6, not 15.
  resetToolCallLoopGuard();
  for (let i = 1; i <= 6; i++) {
    const result = checkToolCallLoop('ToolSearch', { query: `q${i}` });
    assert.ok(result.block === false, `ToolSearch call ${i} should be allowed`);
  }
  const blocked = checkToolCallLoop('ToolSearch', { query: 'q7' });
  assert.ok(blocked.block === true, 'ToolSearch: 7th varied call must be blocked by default cap');
  assert.ok(!blocked.reason?.includes('cap 15'), 'ToolSearch must NOT use the repeatable cap');
}

// ═══════════════════════════════════════════════════════════════════════════
