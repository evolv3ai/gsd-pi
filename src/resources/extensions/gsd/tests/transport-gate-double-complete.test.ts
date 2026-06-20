// gsd-pi — Regression tests for the centralized transport gate and
// milestone double-complete guard (auto-dispatch.ts + phases.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveDispatch } from "../auto-dispatch.ts";
import { openDatabase, closeDatabase, insertMilestone, getMilestone } from "../gsd-db.ts";
import { isClosedStatus } from "../status-guards.ts";
import { getWorkflowTransportSupportError } from "../workflow-mcp.ts";

// ── transport gate: getWorkflowTransportSupportError blocks missing tools ────

test("getWorkflowTransportSupportError blocks when required non-surface tools are missing", () => {
  const err = getWorkflowTransportSupportError(
    "claude-code",
    ["custom_non_surface_tool"],
    {
      projectRoot: process.cwd(),
      surface: "auto-mode",
      unitType: "execute-task",
      authMode: "externalCli",
      baseUrl: "local://claude-code",
      activeTools: ["some_other_tool"],
    },
  );
  assert.ok(err, "should return an error when required non-surface tools are missing from activeTools");
  assert.match(err, /cannot run/i);
});

test("getWorkflowTransportSupportError passes for non-MCP transport", () => {
  const err = getWorkflowTransportSupportError(
    "claude-code",
    ["custom_non_surface_tool"],
    {
      projectRoot: process.cwd(),
      surface: "auto-mode",
      unitType: "execute-task",
      authMode: "apiKey",
      baseUrl: "https://api.anthropic.com",
      activeTools: [],
    },
  );
  assert.equal(err, null, "non-MCP transport should not be blocked");
});

test("resolveDispatch allows dispatch when MCP tools are available", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-transport-pass-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const action = await resolveDispatch({
    basePath: base,
    mid: "M001",
    midTitle: "Test",
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice" },
      activeTask: { id: "M001/S01/T01", title: "Task", status: "pending" },
      registry: [],
      blockers: [],
    } as any,
    prefs: undefined,
    // No transport gate deps → no MCP check → dispatch should go through
  });

  assert.equal(action.action, "dispatch");
});

// ── double-complete guard: isClosedStatus prevents duplicate closeout ────────

test("isClosedStatus detects complete milestone status", () => {
  assert.equal(isClosedStatus("complete"), true);
  assert.equal(isClosedStatus("done"), true);
  assert.equal(isClosedStatus("skipped"), true);
  assert.equal(isClosedStatus("closed"), true);
  assert.equal(isClosedStatus("active"), false);
  assert.equal(isClosedStatus("pending"), false);
  assert.equal(isClosedStatus(""), false);
});

test("getMilestone + isClosedStatus guards against double-complete dispatch", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-double-complete-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  insertMilestone({ id: "M001", title: "Test", status: "complete" });

  // resolveDispatch itself checks for closed milestones at the top
  // (before any dispatch rule fires), which is the same guard used
  // by the phases.ts double-complete check.
  const milestone = getMilestone("M001");
  assert.ok(milestone, "milestone should exist in DB");
  assert.equal(isClosedStatus(milestone.status), true, "closed milestone must be detected");
});

test("resolveDispatch stops on closed milestone before dispatching", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-closed-milestone-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  insertMilestone({ id: "M001", title: "Test", status: "complete" });

  const action = await resolveDispatch({
    basePath: base,
    mid: "M001",
    midTitle: "Test",
    state: {
      phase: "complete",
      activeMilestone: { id: "M001", title: "Test", status: "complete" },
      activeSlice: null,
      activeTask: null,
      registry: [],
      blockers: [],
    } as any,
    prefs: undefined,
  });

  assert.equal(action.action, "stop");
  assert.match(action.reason ?? "", /closed/i);
});
