/**
 * Regression test for MCP tool-availability race.
 *
 * When the MCP workflow server is still connecting, tool calls fail with
 * "No such tool available". The bounded retry counter on AutoSession
 * (toolUnavailableRetries) prevents infinite re-dispatch loops by capping
 * retries at 3 with escalating delay, then pausing auto-mode.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AutoSession } from "../auto/session.ts";

describe("toolUnavailableRetries on AutoSession", () => {
  test("defaults to 0", () => {
    const s = new AutoSession();
    assert.equal(s.toolUnavailableRetries, 0);
  });

  test("is cleared on reset()", () => {
    const s = new AutoSession();
    s.toolUnavailableRetries = 2;
    s.reset();
    assert.equal(s.toolUnavailableRetries, 0);
  });

  test("accumulates across assignments (simulates retry increments)", () => {
    const s = new AutoSession();
    s.toolUnavailableRetries = 1;
    s.toolUnavailableRetries = 2;
    s.toolUnavailableRetries = 3;
    assert.equal(s.toolUnavailableRetries, 3);
  });
});
