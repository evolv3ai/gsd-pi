// Project/App: gsd-pi
// File Purpose: Deterministic timing tests for the exec-sandbox graceful-kill
// ladder + hard-deadline force-resolve (S04/T02).
//
// T01 extended runExecSandbox's timeout path to a graceful
// SIGTERM -> grace -> SIGKILL ladder (via killProcessTree) plus a caller-side
// force-resolve hard deadline so a non-closing ("D-state") child can never hang
// the awaiting promise. A true D-state child is non-portable, so we simulate the
// exact symptom deterministically:
//   1. A SIGTERM-cooperative child (trap 'exit 0' TERM) closes promptly on the
//      first SIGTERM — proving the ladder resolves via `close` well before the
//      force-resolve deadline.
//   2. A SIGTERM-ignoring (trap '' TERM) child combined with a LARGE
//      kill_grace_ms (so SIGKILL never fires in-window) and a SHORT
//      force_resolve_delay_ms — the only way the promise can settle is the
//      hard deadline, proving the no-hang guarantee.
//
// Unlike the sync bash path (which throws on force-resolve), runExecSandbox
// always RESOLVES; force-resolve calls finalize(null, "SIGKILL") and preserves
// timed_out === true so the agent can still distinguish a graceful timeout exit
// from a forced kill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXEC_DEFAULTS, runExecSandbox, type ExecSandboxOptions } from '../exec-sandbox.ts';

const isWin = process.platform === 'win32';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-exec-gracekill-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function baseOpts(base: string, overrides: Partial<ExecSandboxOptions> = {}): ExecSandboxOptions {
  return {
    baseDir: base,
    clamp_timeout_ms: EXEC_DEFAULTS.clampTimeoutMs,
    default_timeout_ms: 10_000,
    stdout_cap_bytes: 1_024,
    stderr_cap_bytes: 1_024,
    digest_chars: 120,
    env_allowlist: EXEC_DEFAULTS.envAllowlist,
    ...overrides,
  };
}

// Wall-clock guard: reject if the call has not settled by `ms`. Proves no-hang
// independently of the assertions on timing/markers.
function wallClockGuard<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Call did not settle within ${ms}ms (hang)`)), ms);
      if (typeof t === 'object' && 'unref' in t) t.unref();
    }),
  ]);
}

// Clean up a detached child (and its process group) that a large kill_grace_ms
// intentionally leaves alive past the force-resolve deadline.
function cleanupByPidFile(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (isWin) return; // best-effort; test is skipped on win32
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

test(
  'runExecSandbox: SIGTERM-cooperative child exits promptly within grace on timeout',
  { skip: isWin ? 'Unix-primary graceful semantics' : false, timeout: 20_000 },
  async (t) => {
    const base = freshBase();
    t.after(() => cleanup(base));

    const KILL_GRACE_MS = 5_000;
    const FORCE_RESOLVE_DELAY_MS = 8_000; // grace + hard-deadline; must NOT be reached
    const TIMEOUT_MS = 300;

    // Child traps SIGTERM and exits 0, then sleeps long. The first SIGTERM from
    // the ladder ends it immediately -> `close` fires -> finalize via close,
    // well before the force-resolve deadline.
    const script = `trap 'exit 0' TERM; sleep 30`;

    const result = await wallClockGuard(
      runExecSandbox(
        { runtime: 'bash', script, timeout_ms: TIMEOUT_MS },
        baseOpts(base, {
          kill_grace_ms: KILL_GRACE_MS,
          force_resolve_delay_ms: FORCE_RESOLVE_DELAY_MS,
        }),
      ),
      15_000,
    );

    // timed_out is preserved even though the child exited cooperatively.
    assert.equal(result.timed_out, true, 'timeout fired so timed_out must be true');
    // Proves SIGTERM (close) resolved it, NOT the force-resolve deadline:
    // a force-resolve would land at ~TIMEOUT_MS + FORCE_RESOLVE_DELAY_MS (~8.3s).
    assert.ok(
      result.duration_ms < KILL_GRACE_MS,
      `expected prompt close well under grace (${KILL_GRACE_MS}ms), got ${result.duration_ms}ms`,
    );
    // A clean SIGTERM-trapped exit resolves via `close` with an exit code,
    // not the force-resolve sentinel (exit_code null / signal SIGKILL).
    assert.notEqual(
      result.signal,
      'SIGKILL',
      'cooperative child must not be force-resolved as SIGKILL',
    );
    assert.equal(result.force_resolved, false, 'a cooperative close must not be flagged as force-resolved');
  },
);

test(
  'runExecSandbox: SIGTERM-ignoring (non-closing) child force-resolves via hard deadline without hanging',
  { skip: isWin ? 'Unix-primary graceful semantics; force-resolve covered on POSIX' : false, timeout: 20_000 },
  async (t) => {
    const base = freshBase();
    const pidFile = join(base, 'child.pid');
    t.after(() => {
      cleanupByPidFile(pidFile);
      cleanup(base);
    });

    // Timing seams: SIGKILL never fires in-window (grace huge), so the only way
    // the promise can settle is the hard deadline -> proves the caller-side
    // force-resolve.
    const KILL_GRACE_MS = 30_000;
    const FORCE_RESOLVE_DELAY_MS = 800;
    // Generous timeout so the SIGTERM trap is reliably installed before the kill
    // fires, even under heavy parallel test load. A too-tight timeout can race
    // the shell's startup: the kill lands before `trap '' TERM` runs, SIGTERM
    // takes its default action, the child closes on SIGTERM, and the
    // force-resolve path never runs (flaky 'SIGTERM' instead of 'SIGKILL').
    const TIMEOUT_MS = 1_500;

    // Install the SIGTERM trap FIRST (before any other command) so the shell is
    // already immune by the time the kill fires; then record the detached
    // shell's PID (process-group leader) for cleanup. The shell loops forever
    // holding its stdout pipe open -> `close` never fires in-window -> the
    // caller's hard deadline must force-resolve.
    const script = `trap '' TERM; echo $$ > '${pidFile}'; while true; do sleep 1; done`;

    const start = Date.now();
    const result = await wallClockGuard(
      runExecSandbox(
        { runtime: 'bash', script, timeout_ms: TIMEOUT_MS },
        baseOpts(base, {
          kill_grace_ms: KILL_GRACE_MS,
          force_resolve_delay_ms: FORCE_RESOLVE_DELAY_MS,
        }),
      ),
      8_000,
    );
    const elapsed = Date.now() - start;

    // (a) Did not hang and settled well before the SIGKILL grace would fire.
    assert.ok(
      elapsed < KILL_GRACE_MS,
      `expected force-resolve before SIGKILL grace (${KILL_GRACE_MS}ms), took ${elapsed}ms`,
    );
    // (b) Settled in the force-resolve band: >= timeout (kill initiated) and
    //     roughly timeout + force_resolve_delay (generous CI slack, but kept below
    //     the 8000ms wallClockGuard so the upper bound is actually reachable).
    assert.ok(
      elapsed >= TIMEOUT_MS && elapsed <= TIMEOUT_MS + FORCE_RESOLVE_DELAY_MS + 4_000,
      `expected settle near ${TIMEOUT_MS + FORCE_RESOLVE_DELAY_MS}ms, took ${elapsed}ms`,
    );
    // (c) Force-resolve preserves timed_out and surfaces the SIGKILL sentinel
    //     (exit_code null) plus the explicit force_resolved flag, so the agent can
    //     tell a forced kill (D-state hard deadline) from a clean SIGKILL exit.
    assert.equal(result.timed_out, true, 'force-resolve must preserve timed_out');
    assert.equal(result.exit_code, null, 'force-resolve exit_code must be null');
    assert.equal(result.signal, 'SIGKILL', 'force-resolve must mark signal SIGKILL');
    assert.equal(result.force_resolved, true, 'force-resolve must set force_resolved=true');
  },
);
