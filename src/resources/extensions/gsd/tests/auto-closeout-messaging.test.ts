// Project/App: gsd-pi
// File Purpose: Tests for premature auto-mode closeout chat rewrites.

import test from "node:test";
import assert from "node:assert/strict";

import {
  rewritePrematureCloseoutLine,
  rewritePrematureCloseoutText,
  sanitizePrematureCloseoutMessageEnd,
} from "../auto-closeout-messaging.ts";

test("rewritePrematureCloseoutLine rewrites milestone complete to closeout submitted", () => {
  assert.equal(
    rewritePrematureCloseoutLine("Milestone M005 complete."),
    "Milestone M005 closeout submitted.",
  );
  assert.equal(
    rewritePrematureCloseoutLine("  Milestone M005 complete  "),
    "Milestone M005 closeout submitted.",
  );
});

test("rewritePrematureCloseoutLine rewrites slice, task, uat, quick-task, and triage lines", () => {
  assert.equal(rewritePrematureCloseoutLine("Slice S01 complete."), "Slice S01 closeout submitted.");
  assert.equal(rewritePrematureCloseoutLine("Task T03 complete."), "Task T03 closeout submitted.");
  assert.equal(rewritePrematureCloseoutLine("UAT S02 complete."), "UAT S02 results submitted.");
  assert.equal(rewritePrematureCloseoutLine("Quick task 4 complete."), "Quick task 4 closeout submitted.");
  assert.equal(rewritePrematureCloseoutLine("Triage complete."), "Triage closeout submitted.");
});

test("rewritePrematureCloseoutText leaves unrelated prose unchanged", () => {
  const input = [
    "Verification summary:",
    "- tests passed",
    "Milestone M005 complete.",
    "No further work needed.",
  ].join("\n");
  const output = rewritePrematureCloseoutText(input);
  assert.match(output, /Milestone M005 closeout submitted\./);
  assert.match(output, /Verification summary:/);
  assert.doesNotMatch(output, /Milestone M005 complete\./);
});

test("sanitizePrematureCloseoutMessageEnd rewrites assistant text blocks in place", () => {
  const event = {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Milestone M005 complete." }],
    },
  };
  sanitizePrematureCloseoutMessageEnd(event);
  assert.equal(
    (event.message.content[0] as { text: string }).text,
    "Milestone M005 closeout submitted.",
  );
});

test("sanitizePrematureCloseoutMessageEnd ignores non-assistant messages", () => {
  const event = {
    message: {
      role: "user",
      content: [{ type: "text", text: "Milestone M005 complete." }],
    },
  };
  sanitizePrematureCloseoutMessageEnd(event);
  assert.equal(
    (event.message.content[0] as { text: string }).text,
    "Milestone M005 complete.",
  );
});
