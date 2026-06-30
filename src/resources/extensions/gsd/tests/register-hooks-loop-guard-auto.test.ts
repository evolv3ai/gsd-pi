import test from "node:test";
import assert from "node:assert/strict";

import { autoSession } from "../auto-runtime-state.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import { resetToolCallLoopGuard } from "../bootstrap/tool-call-loop-guard.ts";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeHookHarness(): {
  emitToolCall: (toolName: string, input: Record<string, unknown>) => Promise<any>;
} {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  };
  const ctx = {
    cwd: process.cwd(),
    ui: { notify: () => undefined },
  };
  let callId = 0;

  registerHooks(pi as any, []);

  return {
    async emitToolCall(toolName: string, input: Record<string, unknown>): Promise<any> {
      callId += 1;
      const loopGuardHandler = handlers.get("tool_call")?.[0];
      assert.ok(loopGuardHandler, "loop-guard tool_call handler should be registered");
      return loopGuardHandler({ toolCallId: `loop-${callId}`, toolName, input }, ctx);
    },
  };
}

test("register-hooks keeps loop-guard block reason interactive outside auto-mode", async (t) => {
  autoSession.reset();
  resetToolCallLoopGuard();
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
  });

  const { emitToolCall } = makeHookHarness();

  for (let i = 0; i < 4; i += 1) {
    await emitToolCall("web_search", { query: "same query" });
  }
  const block = await emitToolCall("web_search", { query: "same query" });

  assert.equal(block?.block, true);
  assert.match(block.reason, /respond to the user in text/);
  assert.doesNotMatch(block.reason, /auto-mode recovery\/replan path/);
});

test("register-hooks rewrites loop-guard block reason for auto-mode identical-args blocks", async (t) => {
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
  });

  const { emitToolCall } = makeHookHarness();

  for (let i = 0; i < 4; i += 1) {
    await emitToolCall("web_search", { query: "same query" });
  }
  const block = await emitToolCall("web_search", { query: "same query" });

  assert.equal(block?.block, true);
  assert.match(block.reason, /Tool loop detected \(identical args\): web_search/);
  assert.match(block.reason, /Do not re-issue this blocked tool/);
  assert.match(block.reason, /auto-mode recovery\/replan path/);
  assert.doesNotMatch(block.reason, /respond to the user in text/);
});

test("register-hooks rewrites loop-guard block reason for auto-mode per-tool blocks", async (t) => {
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
  });

  const { emitToolCall } = makeHookHarness();

  for (let i = 0; i < 6; i += 1) {
    await emitToolCall("gsd_complete_milestone", { milestone: `M${i}` });
  }
  const block = await emitToolCall("gsd_complete_milestone", { milestone: "M7" });

  assert.equal(block?.block, true);
  assert.match(block.reason, /Tool loop detected \(repeated tool\): gsd_complete_milestone/);
  assert.match(block.reason, /Do not re-issue this blocked tool/);
  assert.match(block.reason, /auto-mode recovery\/replan path/);
  assert.doesNotMatch(block.reason, /respond to the user in text/);
});
