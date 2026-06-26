// Project/App: gsd-pi
// File Purpose: Contract coverage for terminal tool-surface failure classification (#783).
//
// A terminal MCP server status (failed / needs-auth / disabled) must not be
// classified as transient — retrying the same model cannot repair a dead
// server and burns retries until the per-unit cost cap pauses auto-mode.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { isTerminalToolSurfaceError, getToolSurfaceReadinessError, TOOL_SURFACE_NOT_READY } from "../tool-surface-readiness.ts";
import { classifyError, isTransient } from "../error-classifier.ts";

const SERVER = "gsd-workflow";

function readinessFor(status: string): string {
  return getToolSurfaceReadinessError({
    unitType: "run-uat",
    workflowServerName: SERVER,
    observation: { tools: ["read"], mcpServers: [{ name: SERVER, status }] },
  })!;
}

describe("isTerminalToolSurfaceError", () => {
  test("recognizes every canonical terminal status", () => {
    for (const status of ["failed", "needs-auth", "disabled"]) {
      const error = readinessFor(status);
      assert.ok(error, `expected a readiness error for status=${status}`);
      assert.equal(
        isTerminalToolSurfaceError(error),
        true,
        `status=${status} should be terminal`,
      );
    }
  });

  test("returns false for genuinely transient (not-yet-connected) variants", () => {
    assert.equal(isTerminalToolSurfaceError(readinessFor("pending")), false);
    assert.equal(isTerminalToolSurfaceError(readinessFor("connected")), false);
    assert.equal(isTerminalToolSurfaceError(readinessFor("connecting")), false);
  });

  test("returns false for non-readiness and unrelated messages", () => {
    assert.equal(isTerminalToolSurfaceError(null), false);
    assert.equal(isTerminalToolSurfaceError(undefined), false);
    assert.equal(isTerminalToolSurfaceError(""), false);
    assert.equal(isTerminalToolSurfaceError("some unrelated network error"), false);
    // A bare "(terminal)" without a real readiness prefix/status must not trip.
    assert.equal(isTerminalToolSurfaceError("something (terminal) happened"), false);
  });

  test("the readiness prefix alone (without the terminal marker) is not terminal", () => {
    const transientMessage = `${TOOL_SURFACE_NOT_READY} for run-uat: MCP server "${SERVER}" is absent from the init surface (not yet connected): gsd_uat_exec`;
    assert.equal(isTerminalToolSurfaceError(transientMessage), false);
  });
});

describe("classifyError terminal readiness contract (#783)", () => {
  test("every terminal status classifies as non-transient permanent", () => {
    for (const status of ["failed", "needs-auth", "disabled"]) {
      const cls = classifyError(`Claude Code error: ${readinessFor(status)}`);
      assert.equal(isTransient(cls), false, `status=${status} must not be transient`);
      assert.equal(cls.kind, "permanent", `status=${status} must classify as permanent`);
    }
  });

  test("transient not-yet-connected variants still classify as transient network", () => {
    const cls = classifyError(`Claude Code error: ${readinessFor("pending")}`);
    assert.equal(isTransient(cls), true);
    assert.equal(cls.kind, "network");
  });

  test("terminal branch is matched ahead of the shared transient prefix branch", () => {
    // The failed-status message shares the TOOL_SURFACE_NOT_READY prefix with
    // the transient branches. If ordering regressed, this would be `network`.
    const cls = classifyError(readinessFor("needs-auth"));
    assert.notEqual(cls.kind, "network");
    assert.equal(cls.kind, "permanent");
  });
});
