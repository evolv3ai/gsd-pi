// GSD Extension — Stop Notice module tests
// Locks the emitter↔detector round-trip: every notice the formatters produce
// must be recognized by the classifiers the headless host uses for exit codes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  formatStopNoticePrefix,
  isBlockedStopReason,
  stopNoticeDisplayReason,
  stopNoticeKind,
  isTerminalNotice,
  isPauseNotice,
  isBlockedNoticeMessage,
  isManualResolutionNotice,
  PAUSED_NOTICE_PREFIXES,
  TERMINAL_NOTICE_PREFIXES,
} from "../stop-notice.js";

describe("stop notice formatting", () => {
  test("plain stop has no reason suffix", () => {
    assert.equal(formatStopNoticePrefix(), "Auto-mode stopped");
    assert.equal(formatStopNoticePrefix(null), "Auto-mode stopped");
  });

  test("reason is appended after an em-dash", () => {
    assert.equal(formatStopNoticePrefix("user request"), "Auto-mode stopped — user request");
  });

  test("Blocked: marker switches the prefix and is stripped from display", () => {
    assert.equal(formatStopNoticePrefix("Blocked: validation gate"), "Auto-mode blocked — validation gate");
    assert.equal(stopNoticeKind("Blocked: x"), "blocked");
    assert.equal(stopNoticeKind("stop"), "stopped");
    assert.ok(isBlockedStopReason("blocked: lowercase too"));
    assert.equal(stopNoticeDisplayReason("Blocked:  spaced "), "spaced");
  });
});

describe("emitter↔detector round-trip", () => {
  test("formatted stop notices classify as terminal", () => {
    for (const reason of [undefined, "user request"]) {
      const message = formatStopNoticePrefix(reason).toLowerCase();
      assert.ok(isTerminalNotice(message), `not terminal: ${message}`);
    }
  });

  test("pause prefixes classify as pause and as blocked (operator intervention)", () => {
    for (const prefix of PAUSED_NOTICE_PREFIXES) {
      assert.ok(isPauseNotice(`${prefix}: provider error`));
      assert.ok(isBlockedNoticeMessage(`${prefix}: provider error`));
    }
  });

  test("idempotent-advance pauses are non-blocking", () => {
    assert.equal(isBlockedNoticeMessage("auto-mode paused (idempotent advance: unit already active)"), false);
  });

  test("manual-resolution notices classify as blocked", () => {
    const message = "merge conflict — resolve manually and re-run /gsd auto";
    assert.ok(isManualResolutionNotice(message));
    assert.ok(isBlockedNoticeMessage(message));
  });

  test("terminal prefixes cover the known stop vocabulary", () => {
    for (const message of ["auto-mode stopped.", "auto-mode complete", "auto-mode idle", "no active milestone"]) {
      assert.ok(TERMINAL_NOTICE_PREFIXES.some((prefix) => message.startsWith(prefix)), message);
    }
  });
});
