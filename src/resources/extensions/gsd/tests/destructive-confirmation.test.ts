/**
 * Tests for the destructive-command confirmation escape hatch.
 *
 * Regression target: the destructive-guard hard block had no confirmation
 * path. Re-issuing a force push after confirming via ask_user_questions hit
 * the identical HARD BLOCK every time — an unwinnable loop. These tests pin
 * the block → confirm → allow-once flow and its safety invariants.
 *
 * Two layers of coverage:
 *  1. Unit — the confirmation-token module in isolation (block/confirm/consume
 *     and every safety invariant).
 *  2. Integration — the real registerHooks() bash tool_call guard +
 *     ask_user_questions tool_result handler driven end-to-end, proving the
 *     loop is escapable through the actual wiring, not just the helper module.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import { classifyCommand } from "../safety/destructive-guard.ts";
import {
  DESTRUCTIVE_CONFIRM_GATE_MARKER,
  confirmDestructiveCommand,
  consumeDestructiveConfirmation,
  isDestructiveConfirmGateId,
  normalizeDestructiveCommand,
  peekPendingDestructiveCommand,
  requestDestructiveConfirmation,
  resetDestructiveConfirmation,
} from "../safety/destructive-confirmation.ts";

const BASE = "/tmp/gsd-destructive-confirm-test";
const FORCE_PUSH = "git push --force-with-lease origin feature/PO-566-chart-supply-chain";

function blocked(command: string, basePath: string): boolean {
  // Mirror the guard's decision: a classified-destructive command is blocked
  // unless a matching confirmation token is consumed in this same check.
  if (!classifyCommand(command).destructive) return false;
  return !consumeDestructiveConfirmation(command, basePath);
}

test("repro: destructive command loops forever without confirmation", () => {
  resetDestructiveConfirmation(BASE);
  // Every attempt blocks — this is the bug the escape hatch fixes.
  assert.equal(blocked(FORCE_PUSH, BASE), true, "first attempt blocks");
  assert.equal(blocked(FORCE_PUSH, BASE), true, "retry still blocks");
  assert.equal(blocked(FORCE_PUSH, BASE), true, "and again — unwinnable loop");
});

test("block then confirm then retry allows the exact command once", () => {
  resetDestructiveConfirmation(BASE);

  // 1. Guard blocks and records the pending command.
  assert.equal(blocked(FORCE_PUSH, BASE), true, "initial attempt blocks");
  requestDestructiveConfirmation(FORCE_PUSH, BASE);
  assert.equal(peekPendingDestructiveCommand(BASE), normalizeDestructiveCommand(FORCE_PUSH));

  // 2. User confirms via ask_user_questions affirmative answer.
  const confirmed = confirmDestructiveCommand(BASE);
  assert.equal(confirmed, normalizeDestructiveCommand(FORCE_PUSH));

  // 3. Retry in the same turn now passes.
  assert.equal(blocked(FORCE_PUSH, BASE), false, "confirmed command passes once");
});

test("confirmation is one-shot — a second destructive command re-blocks", () => {
  resetDestructiveConfirmation(BASE);

  requestDestructiveConfirmation(FORCE_PUSH, BASE);
  confirmDestructiveCommand(BASE);
  assert.equal(blocked(FORCE_PUSH, BASE), false, "first run consumes the token");
  assert.equal(blocked(FORCE_PUSH, BASE), true, "identical second run re-blocks");
});

test("confirmation is command-bound — a different command is not approved", () => {
  resetDestructiveConfirmation(BASE);

  requestDestructiveConfirmation(FORCE_PUSH, BASE);
  confirmDestructiveCommand(BASE);

  // A different destructive command must not ride the force-push confirmation.
  assert.equal(blocked("rm -rf node_modules", BASE), true, "unrelated destructive cmd re-blocks");
  // The original token is still intact for its exact command.
  assert.equal(blocked(FORCE_PUSH, BASE), false, "original confirmed command still passes once");
});

test("cosmetic whitespace reformatting still matches the confirmed token", () => {
  resetDestructiveConfirmation(BASE);

  requestDestructiveConfirmation("git push   --force  origin   main", BASE);
  confirmDestructiveCommand(BASE);
  assert.equal(blocked("git push --force origin main", BASE), false, "whitespace-normalized match passes");
});

test("requesting a new confirmation invalidates a stale confirmed token", () => {
  resetDestructiveConfirmation(BASE);

  requestDestructiveConfirmation(FORCE_PUSH, BASE);
  confirmDestructiveCommand(BASE);
  // New block for a different command before the first was consumed.
  requestDestructiveConfirmation("git reset --hard HEAD~3", BASE);
  assert.equal(blocked(FORCE_PUSH, BASE), true, "old confirmation no longer valid after new request");
});

test("confirm with nothing pending returns null and approves nothing", () => {
  resetDestructiveConfirmation(BASE);
  assert.equal(confirmDestructiveCommand(BASE), null, "no pending command -> null");
  assert.equal(blocked(FORCE_PUSH, BASE), true, "no spurious approval");
});

test("tokens are isolated per basePath", () => {
  const a = "/tmp/gsd-confirm-ws-a";
  const b = "/tmp/gsd-confirm-ws-b";
  resetDestructiveConfirmation(a);
  resetDestructiveConfirmation(b);

  requestDestructiveConfirmation(FORCE_PUSH, a);
  confirmDestructiveCommand(a);

  assert.equal(blocked(FORCE_PUSH, b), true, "workspace B is unaffected by workspace A's confirmation");
  assert.equal(blocked(FORCE_PUSH, a), false, "workspace A still passes once");
});

test("gate id marker detection", () => {
  assert.equal(isDestructiveConfirmGateId(`${DESTRUCTIVE_CONFIRM_GATE_MARKER}_push`), true);
  assert.equal(isDestructiveConfirmGateId("depth_verification_M001"), false);
  assert.equal(isDestructiveConfirmGateId(undefined), false);
  assert.equal(isDestructiveConfirmGateId(123), false);
});

test("non-destructive commands are never gated regardless of token state", () => {
  resetDestructiveConfirmation(BASE);
  assert.equal(blocked("git status", BASE), false);
  assert.equal(blocked("ls -la", BASE), false);
});

// ─── Integration: real registerHooks() wiring, driven end-to-end ────────────
// The unit tests above exercise the token module directly. These drive the
// actual registered bash tool_call guard and ask_user_questions tool_result
// handler, proving the loop the user hit is escapable through the real hooks —
// not just the helper. Mirrors the harness in
// register-hooks-depth-verification.test.ts.

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeHookHarness(): {
  handlers: Map<string, Handler[]>;
  pi: any;
} {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;
  return { handlers, pi };
}

/** Run every bash tool_call guard and return the first block result, if any. */
async function runBashGuard(
  handlers: Map<string, Handler[]>,
  command: string,
  ctx: any,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  let block: { block?: boolean; reason?: string } | undefined;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler(
      { toolCallId: "bash-1", toolName: "bash", input: { command } },
      ctx,
    );
    if (result?.block) block = result;
  }
  return block;
}

/** Deliver an affirmative ask_user_questions answer for a destructive gate. */
async function answerConfirmGate(
  handlers: Map<string, Handler[]>,
  questionId: string,
  ctx: any,
): Promise<void> {
  const questions = [
    {
      id: questionId,
      question: "Run this destructive command?",
      options: [{ label: "Yes, run it (Recommended)" }, { label: "No, cancel" }],
    },
  ];
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler(
      {
        toolName: "ask_user_questions",
        input: { questions },
        details: {
          response: { answers: { [questionId]: { selected: "Yes, run it (Recommended)" } } },
        },
      },
      ctx,
    );
  }
}

test("integration: real hooks block a force push, then allow it once after confirmation", async (t) => {
  const dir = "/tmp/gsd-destructive-confirm-int-allow";
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;
  resetDestructiveConfirmation(dir);
  t.after(() => resetDestructiveConfirmation(dir));

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);

  // 1. First attempt is hard-blocked by the real guard, with instructions that
  //    name the destructive_confirm gate.
  const firstBlock = await runBashGuard(handlers, FORCE_PUSH, ctx);
  assert.equal(firstBlock?.block, true, "real guard blocks the first attempt");
  assert.match(firstBlock?.reason ?? "", /HARD BLOCK: destructive Bash command/);
  assert.match(firstBlock?.reason ?? "", /force push/);
  assert.match(firstBlock?.reason ?? "", /destructive_confirm/);

  // 2. User answers an affirmative destructive_confirm gate.
  await answerConfirmGate(handlers, "destructive_confirm_force_push", ctx);

  // 3. Re-issuing the exact command in the same turn now runs once (no block).
  const secondAttempt = await runBashGuard(handlers, FORCE_PUSH, ctx);
  assert.equal(secondAttempt, undefined, "confirmed command passes the real guard once");

  // 4. One-shot: an immediate identical third attempt re-blocks.
  const thirdAttempt = await runBashGuard(handlers, FORCE_PUSH, ctx);
  assert.equal(thirdAttempt?.block, true, "second run of the same command re-blocks (one-shot)");
});

test("integration: declining the confirm gate leaves the command blocked", async (t) => {
  const dir = "/tmp/gsd-destructive-confirm-int-decline";
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;
  resetDestructiveConfirmation(dir);
  t.after(() => resetDestructiveConfirmation(dir));

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);

  assert.equal((await runBashGuard(handlers, FORCE_PUSH, ctx))?.block, true, "first attempt blocks");

  // Decline: the non-affirmative (non-first) option must NOT promote a token.
  const questions = [
    {
      id: "destructive_confirm_force_push",
      question: "Run this destructive command?",
      options: [{ label: "Yes, run it (Recommended)" }, { label: "No, cancel" }],
    },
  ];
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler(
      {
        toolName: "ask_user_questions",
        input: { questions },
        details: {
          response: { answers: { "destructive_confirm_force_push": { selected: "No, cancel" } } },
        },
      },
      ctx,
    );
  }

  assert.equal(
    (await runBashGuard(handlers, FORCE_PUSH, ctx))?.block,
    true,
    "declined command stays blocked",
  );
});

test("integration: a confirm token does not leak to a different destructive command", async (t) => {
  const dir = "/tmp/gsd-destructive-confirm-int-bound";
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;
  resetDestructiveConfirmation(dir);
  t.after(() => resetDestructiveConfirmation(dir));

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);

  await runBashGuard(handlers, FORCE_PUSH, ctx);
  await answerConfirmGate(handlers, "destructive_confirm_force_push", ctx);

  // A different destructive command must not ride the force-push confirmation.
  // In the real guard, blocking this command also records it as pending, which
  // invalidates the stale force-push token (stale-token safety invariant) — so
  // the original confirmation is consumed/cleared, not left dangling.
  assert.equal(
    (await runBashGuard(handlers, "rm -rf build", ctx))?.block,
    true,
    "unrelated destructive command is still blocked",
  );
  // Because the unrelated block invalidated the stale token, the original
  // force-push now re-blocks too: a confirmation never survives an intervening
  // destructive command. This is stricter (safer) than per-command isolation.
  assert.equal(
    (await runBashGuard(handlers, FORCE_PUSH, ctx))?.block,
    true,
    "force-push token was invalidated by the intervening destructive block",
  );
});
