// gsd-pi + src/resources/extensions/gsd/tests/fallback-continuation.test.ts - Regression test for #804 fallback continuation dispatch.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from "node:test";
import assert from "node:assert/strict";

import { scheduleFallbackContinuation } from "../bootstrap/fallback-continuation.ts";

/**
 * #804: After switching to a fallback model in the agent_end recovery path, the
 * continuation must be dispatched on a *fresh* turn — not as a steering message
 * against the turn that just errored out (which `isStreaming` is still true for
 * until finishRun() clears it). The fix defers the send to a macrotask and uses
 * a plain `triggerTurn` with no `deliverAs: "steer"`.
 */
test("scheduleFallbackContinuation defers a plain triggerTurn dispatch (no steer)", async () => {
  const calls: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    sendMessage: (message: unknown, options: unknown) => {
      calls.push({ message, options });
    },
  } as any;

  scheduleFallbackContinuation(pi);

  // Synchronous within the awaited agent_end listener: nothing sent yet so the
  // dispatch cannot be misrouted into the still-streaming dying turn.
  assert.equal(calls.length, 0);

  // After the macrotask (finishRun() has cleared isStreaming by now).
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { triggerTurn: true });
  assert.equal((calls[0].options as { deliverAs?: unknown }).deliverAs, undefined);
});
