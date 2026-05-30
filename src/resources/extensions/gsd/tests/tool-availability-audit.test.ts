// Project/App: gsd-pi
// File Purpose: Verify investigation + unit tools survive GSD workflow scoping paths.

import assert from "node:assert/strict";
import test from "node:test";

import { DISCUSS_TOOLS_ALLOWLIST } from "../constants.ts";
import type { ToolInfo } from "@gsd/pi-coding-agent";
import {
  buildMinimalAutoGsdToolSet,
  buildMinimalGsdWorkflowToolSet,
  buildRequestScopedGsdToolSet,
  MINIMAL_AUTO_BASE_TOOL_NAMES,
  scopeGsdWorkflowToolsForDispatch,
} from "../bootstrap/register-hooks.ts";

/** Simulates a fully registered Pi built-in + GSD workflow surface. */
const FULL_REGISTERED_TOOLS = [
  "ask_user_questions",
  "bash",
  "bg_shell",
  "edit",
  "find",
  "glob",
  "grep",
  "fetch_page",
  "search-the-web",
  "ls",
  "read",
  "subagent",
  "write",
  "ToolSearch",
  "gsd_summary_save",
  "gsd_decision_save",
  "gsd_requirement_save",
  "gsd_requirement_update",
  "gsd_plan_milestone",
  "gsd_milestone_generate_id",
  "gsd_task_complete",
  "gsd_complete_milestone",
  "gsd_exec",
  "memory_query",
  "capture_thought",
] as const;

/** Tools discuss/planning prompts reference for codebase investigation. */
const INVESTIGATION_TOOLS = [
  "ask_user_questions",
  "bash",
  "read",
  "grep",
  "find",
  "ls",
  "subagent",
] as const;

/** GSD tools required during discuss-milestone (prompt + backlog mapping). */
const DISCUSS_MILESTONE_GSD_TOOLS = [
  "gsd_summary_save",
  "gsd_decision_save",
  "gsd_requirement_save",
  "gsd_requirement_update",
  "gsd_plan_milestone",
  "gsd_milestone_generate_id",
] as const;

const DISCUSS_UNIT_TYPES = [
  "discuss-milestone",
  "discuss-project",
  "discuss-requirements",
] as const;

function simulateDiscussAllowlistFilter(activeTools: readonly string[]): string[] {
  return activeTools.filter(
    (toolName) => !toolName.startsWith("gsd_") || DISCUSS_TOOLS_ALLOWLIST.includes(toolName),
  );
}

function assertIncludesAll(result: readonly string[], required: readonly string[], label: string): void {
  for (const toolName of required) {
    assert.ok(result.includes(toolName), `${label} missing ${toolName}`);
  }
}

test("discuss allowlist includes every discuss-milestone GSD tool", () => {
  for (const toolName of DISCUSS_MILESTONE_GSD_TOOLS) {
    assert.ok(
      DISCUSS_TOOLS_ALLOWLIST.includes(toolName),
      `DISCUSS_TOOLS_ALLOWLIST missing ${toolName}`,
    );
  }
});

test("buildMinimalGsdWorkflowToolSet includes all registered base tools when active set is minimal", () => {
  const activeTools = ["bash", "read", "write", "gsd_summary_save"];
  const result = buildMinimalGsdWorkflowToolSet(activeTools, [...FULL_REGISTERED_TOOLS]);

  assertIncludesAll(result, MINIMAL_AUTO_BASE_TOOL_NAMES, "workflow tool set");
  assertIncludesAll(result, INVESTIGATION_TOOLS, "workflow investigation tools");
});

test("scopeGsdWorkflowToolsForDispatch without unit type pulls registered investigation tools", () => {
  let activeTools = ["bash", "read", "write", "gsd_summary_save"];
  scopeGsdWorkflowToolsForDispatch({
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools) => {
      activeTools = [...tools];
    },
    getAllTools: () => FULL_REGISTERED_TOOLS.map((name) => ({ name })) as ToolInfo[],
  });

  assertIncludesAll(activeTools, INVESTIGATION_TOOLS, "scopeGsdWorkflowToolsForDispatch");
});

for (const unitType of DISCUSS_UNIT_TYPES) {
  test(`${unitType}: auto scoping keeps investigation tools from registered set`, () => {
    const activeTools = simulateDiscussAllowlistFilter(FULL_REGISTERED_TOOLS);
    const result = buildMinimalAutoGsdToolSet(
      activeTools,
      unitType,
      FULL_REGISTERED_TOOLS,
    );

    assertIncludesAll(result, INVESTIGATION_TOOLS, `${unitType} auto scope`);
  });
}

for (const customType of ["gsd-discuss", "gsd-run"] as const) {
  test(`${customType} + discuss-milestone request scope keeps investigation + requirement tools`, () => {
    const activeTools = ["bash", "read", "write", "gsd_summary_save"];
    const result = buildRequestScopedGsdToolSet(
      activeTools,
      [{ customType }],
      FULL_REGISTERED_TOOLS,
      "discuss-milestone",
    );

    assert.ok(result);
    assertIncludesAll(result, INVESTIGATION_TOOLS, `${customType} request scope`);
    assertIncludesAll(result, DISCUSS_MILESTONE_GSD_TOOLS, `${customType} discuss-milestone GSD tools`);
  });
}

test("discuss-milestone two-stage scoping matches adjust_tool_set request scope", () => {
  const activeTools = simulateDiscussAllowlistFilter(FULL_REGISTERED_TOOLS);
  const dispatchScoped = buildMinimalAutoGsdToolSet(
    activeTools,
    "discuss-milestone",
    FULL_REGISTERED_TOOLS,
  );
  const requestScoped = buildRequestScopedGsdToolSet(
    dispatchScoped,
    [{ customType: "gsd-discuss" }],
    FULL_REGISTERED_TOOLS,
    "discuss-milestone",
  );

  assert.ok(requestScoped);
  for (const toolName of INVESTIGATION_TOOLS) {
    assert.equal(
      requestScoped.includes(toolName),
      dispatchScoped.includes(toolName),
      `${toolName} availability diverged between dispatch and request scope`,
    );
  }
});
