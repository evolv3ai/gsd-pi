import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { autoSession } from "../auto-runtime-state.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import { resetToolCallLoopGuard } from "../bootstrap/tool-call-loop-guard.ts";
import { readUnitHarnessAbort } from "../unit-runtime.ts";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeHookHarness(): {
  emitToolCall: (toolName: string, input: Record<string, unknown>) => Promise<any>;
  emitToolResult: (event: Record<string, unknown>) => Promise<void>;
  emitToolExecutionEnd: (event: Record<string, unknown>) => Promise<void>;
  emitAgentEnd: (event: Record<string, unknown>) => Promise<void>;
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
    async emitToolResult(event: Record<string, unknown>): Promise<void> {
      callId += 1;
      for (const handler of handlers.get("tool_result") ?? []) {
        await handler({
          toolCallId: `result-${callId}`,
          ...event,
        }, ctx);
      }
    },
    async emitToolExecutionEnd(event: Record<string, unknown>): Promise<void> {
      callId += 1;
      for (const handler of handlers.get("tool_execution_end") ?? []) {
        await handler({
          toolCallId: `exec-${callId}`,
          ...event,
        }, ctx);
      }
    },
    async emitAgentEnd(event: Record<string, unknown>): Promise<void> {
      for (const handler of handlers.get("agent_end") ?? []) {
        await handler(event, ctx);
      }
    },
  };
}

function makeRuntimeBase(): string {
  const base = join(tmpdir(), `gsd-hook-runtime-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
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

test("register-hooks does not record normal product tool failures as harness aborts", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "gate-evaluate", id: "M001/S01/gates+Q3", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "mcp__gsd-workflow__browser_click",
    isError: true,
    result: {
      content: [{ type: "text", text: "Element not found: #submit" }],
    },
  });

  const abort = readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt);
  assert.equal(abort, null);
});

test("register-hooks does not classify normal gsd_uat_exec nonzero exits as harness aborts", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_uat_exec",
    isError: true,
    result: {
      content: [{ type: "text", text: "gsd_exec[exec-1] runtime=bash exit=1 duration=12ms" }],
      details: {
        operation: "gsd_uat_exec",
        exit_code: 1,
        aborted: false,
        force_resolved: false,
      },
    },
  });

  const abort = readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt);
  assert.equal(abort, null);
});

test("register-hooks preserves retryable harness abort after later successful tools", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd, emitToolResult } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "mcp__gsd-workflow__browser_click",
    isError: true,
    result: {
      content: [{ type: "text", text: "No such tool available: browser_click" }],
    },
  });

  const recorded = readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt);
  assert.equal(recorded?.kind, "tool-error");

  await emitToolResult({
    toolName: "read",
    isError: false,
    input: { path: "README.md" },
    result: {
      content: [{ type: "text", text: "file contents" }],
    },
  });
  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind,
    "tool-error",
    "successful native tool_result must not clear the harness abort",
  );

  await emitToolExecutionEnd({
    toolName: "read",
    isError: false,
    result: {
      content: [{ type: "text", text: "file contents" }],
    },
  });
  assert.equal(
    readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt)?.kind,
    "tool-error",
    "successful universal tool_execution_end must not clear the harness abort",
  );
});

test("register-hooks does not record save-tool validation errors as harness aborts", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "run-uat", id: "M001/S01", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_uat_result_save",
    isError: true,
    result: {
      content: [{ type: "text", text: "Error: UAT Assessment requires at least one fresh gsd_uat_exec evidence reference" }],
      details: { operation: "save_uat_result", error: "uat_missing_fresh_evidence" },
    },
  });

  const abort = readUnitHarnessAbort(base, "run-uat", "M001/S01", startedAt);
  assert.equal(abort, null);
});

test("register-hooks does not record pending approval hard-blocks as harness aborts", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "gate-evaluate", id: "M001/S01/gates+Q3", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  await emitToolExecutionEnd({
    toolName: "gsd_summary_save",
    isError: true,
    result: {
      content: [{
        type: "text",
        text: 'HARD BLOCK: Discussion gate "depth:M001" has not been confirmed by the user.',
      }],
    },
  });

  const abort = readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt);
  assert.equal(abort, null);
});

test("register-hooks only records agent_end turn aborts for aborted or error stop reasons", async (t) => {
  const base = makeRuntimeBase();
  const startedAt = Date.now();
  autoSession.reset();
  resetToolCallLoopGuard();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.currentUnit = { type: "gate-evaluate", id: "M001/S01/gates+Q3", startedAt };
  t.after(() => {
    autoSession.reset();
    resetToolCallLoopGuard();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitAgentEnd } = makeHookHarness();
  await emitAgentEnd({
    abortOrigin: "auto-context",
    messages: [{ stopReason: "stop" }],
  });

  const abort = readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt);
  assert.equal(abort, null);
});
