import test from "node:test";
import assert from "node:assert/strict";

import { _hasExecutionToolCallsInSessionForTest } from "../auto-post-unit.ts";

test("suppresses empty-evidence warning when session contains bash tool calls", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolName: "bash",
            arguments: { command: "python -m pytest tests/test_types.py -q" },
          },
        ],
      },
    },
  ];

  assert.equal(_hasExecutionToolCallsInSessionForTest(entries), true);
});

test("does not suppress when session has no execution tool calls", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolName: "read",
            arguments: { file_path: "README.md" },
          },
        ],
      },
    },
  ];

  assert.equal(_hasExecutionToolCallsInSessionForTest(entries), false);
});

test("detects top-level gsd_exec tool call with normalized name", () => {
  const entries = [
    { type: "toolCall", name: "  GSD_EXEC  ", arguments: { command: "npm test" } },
  ];

  assert.equal(_hasExecutionToolCallsInSessionForTest(entries), true);
});

test("detects top-level bash tool call via toolName field", () => {
  const entries = [
    { type: "toolCall", toolName: "bash", arguments: { command: "echo ok" } },
  ];

  assert.equal(_hasExecutionToolCallsInSessionForTest(entries), true);
});

test("detects session execution tools supported by the evidence collector", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolName: "async_bash",
            arguments: { command: "npm test" },
          },
          {
            type: "toolCall",
            toolName: "PowerShell",
            arguments: { command: "Get-ChildItem" },
          },
          {
            type: "toolCall",
            toolName: "functions.exec_command",
            arguments: { cmd: "pnpm test" },
          },
        ],
      },
    },
  ];

  assert.equal(_hasExecutionToolCallsInSessionForTest(entries), true);
});

test("detects execution tool calls in bare agent-end messages (no session-entry wrapper)", () => {
  // The auto loop passes opts.agentEndMessages as bare {role, content}
  // messages — not {type: "message", message} session-manager entries.
  const entries = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "Bash",
          arguments: { command: "test -s index.html && grep -q localStorage index.html" },
        },
      ],
    },
  ];

  assert.equal(_hasExecutionToolCallsInSessionForTest(entries), true);
});

test("does not suppress for bare agent-end messages without execution tools", () => {
  const entries = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Task complete." },
        { type: "toolCall", name: "Write", arguments: { file_path: "index.html" } },
      ],
    },
  ];

  assert.equal(_hasExecutionToolCallsInSessionForTest(entries), false);
});

test("ignores bare user messages with toolCall-shaped content", () => {
  const entries = [
    {
      role: "user",
      content: [
        { type: "toolCall", name: "bash", arguments: { command: "echo hi" } },
      ],
    },
  ];

  assert.equal(_hasExecutionToolCallsInSessionForTest(entries), false);
});
