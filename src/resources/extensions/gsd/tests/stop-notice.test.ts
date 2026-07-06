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
  isInteractiveMenuUnavailableNotice,
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

  test("un-showable menu notices classify as blocked (#1294)", () => {
    // Emitted verbatim by notifyCommandMenuUnavailable (next-action-ui.ts / command-feedback.ts).
    const menuUnavailable =
      "gsd — m002: editorial hn menu could not be shown in this session.\nrun /gsd when ready.";
    assert.ok(isInteractiveMenuUnavailableNotice(menuUnavailable));
    assert.ok(isBlockedNoticeMessage(menuUnavailable));

    // Emitted by notifyPickerCommandNeedsInteractiveMenu (command-feedback.ts).
    const pickerGuidance = "/gsd did not start: milestone menu needs an interactive session";
    assert.ok(isInteractiveMenuUnavailableNotice(pickerGuidance));
    assert.ok(isBlockedNoticeMessage(pickerGuidance));

    // Unrelated notices are not swept up.
    assert.equal(isInteractiveMenuUnavailableNotice("auto-mode complete"), false);
  });

  test("terminal prefixes cover the known stop vocabulary", () => {
    for (const message of ["auto-mode stopped.", "auto-mode complete", "auto-mode idle", "no active milestone"]) {
      assert.ok(TERMINAL_NOTICE_PREFIXES.some((prefix) => message.startsWith(prefix)), message);
    }
  });
});
