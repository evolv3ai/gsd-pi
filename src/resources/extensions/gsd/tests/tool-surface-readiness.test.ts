// Project/App: gsd-pi
// File Purpose: Contract coverage for the Tool Surface Readiness gate and its recovery classification.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { getToolSurfaceReadinessError } from "../tool-surface-readiness.ts";
import { isToolUnavailableError } from "../auto-tool-tracking.ts";
import { classifyError, isTransient } from "../error-classifier.ts";
import { classifyFailure } from "../recovery-classification.ts";

const SERVER = "gsd-workflow";

function prefixed(tool: string): string {
  return `mcp__${SERVER}__${tool}`;
}

const RUN_UAT_TOOLS = [
  "gsd_uat_exec",
  "gsd_uat_result_save",
  "gsd_resume",
  "gsd_milestone_status",
  "gsd_journal_query",
];

describe("getToolSurfaceReadinessError", () => {
  test("returns null when no unit type or no workflow server is in play", () => {
    const observation = { tools: [], mcpServers: [] };
    assert.equal(
      getToolSurfaceReadinessError({ unitType: undefined, workflowServerName: SERVER, observation }),
      null,
    );
    assert.equal(
      getToolSurfaceReadinessError({ unitType: "run-uat", workflowServerName: undefined, observation }),
      null,
    );
  });

  test("returns null for units with no required workflow tools", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "rewrite-docs",
      workflowServerName: SERVER,
      observation: { tools: [], mcpServers: [{ name: SERVER, status: "failed" }] },
    });
    assert.equal(error, null);
  });

  test("returns null when the workflow server is not part of the session", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: "other-server", status: "connected" }] },
    });
    assert.equal(error, null);
  });

  test("returns null when all required tools are registered under the MCP prefix", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: ["read", ...RUN_UAT_TOOLS.map(prefixed)],
        mcpServers: [{ name: SERVER, status: "connected" }],
      },
    });
    assert.equal(error, null);
  });

  test("reports the failed server and the missing tools when the surface never registered", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "failed" }] },
    });
    assert.ok(error, "expected a readiness error");
    assert.match(error, /workflow tool surface not ready for run-uat/);
    assert.match(error, /status is "failed"/);
    assert.match(error, /gsd_uat_exec/);
  });

  test("reports partially-registered surfaces even when the server says connected", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: [prefixed("gsd_uat_exec")],
        mcpServers: [{ name: SERVER, status: "connected" }],
      },
    });
    assert.ok(error, "expected a readiness error");
    assert.match(error, /connected but has not registered/);
    assert.match(error, /gsd_uat_result_save/);
    assert.doesNotMatch(error, /gsd_uat_exec,/);
  });
});

describe("readiness error classification contract", () => {
  const readinessError = getToolSurfaceReadinessError({
    unitType: "run-uat",
    workflowServerName: SERVER,
    observation: { tools: [], mcpServers: [{ name: SERVER, status: "pending" }] },
  })!;

  test("auto-tool-tracking treats the readiness error as tool-unavailable", () => {
    assert.equal(isToolUnavailableError(readinessError), true);
  });

  test("error-classifier treats the readiness error as transient", () => {
    const cls = classifyError(`Claude Code error: ${readinessError}`);
    assert.equal(isTransient(cls), true);
  });

  test("Recovery Classification maps the readiness error to tool-unavailable → retry", () => {
    const recovery = classifyFailure({ error: new Error(readinessError), unitType: "run-uat", unitId: "M001" });
    assert.equal(recovery.failureKind, "tool-unavailable");
    assert.equal(recovery.action, "retry");
    assert.equal(recovery.exitReason, "tool-unavailable");
  });
});
