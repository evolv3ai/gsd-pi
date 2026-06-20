// Engine hook contract: which tool lifecycle hooks fire under which engine,
// and the consolidated tool-name normalizer seam.
//
// 1. Pins the contract arrays (engine-hook-contract.ts) so a change to the
//    fire matrix is a deliberate, reviewed act.
// 2. Source-scans register-hooks.ts (in the style of
//    single-writer-invariant.test.ts) to assert that the concerns documented
//    as universally mirrored — evidence collection and write-gate (re-)arming —
//    actually live inside a tool_execution_start handler, not only in the
//    native-only tool_call handlers.
// 3. Pins normalizer parity: canonicalHeadlessToolName delegates to
//    canonicalToolName (strip-only), and canonicalWorkflowToolName adds alias
//    resolution on top of the same strip.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  UNIVERSAL_TOOL_HOOKS,
  NATIVE_ONLY_TOOL_HOOKS,
  canonicalToolName,
  canonicalWorkflowToolName,
} from "../engine-hook-contract.js";
import { canonicalHeadlessToolName } from "../../../../headless-events.js";
import { WORKFLOW_TOOL_ALIAS_PAIRS } from "../workflow-tool-surface.js";

test("contract arrays pin the verified fire matrix", () => {
  assert.deepEqual([...UNIVERSAL_TOOL_HOOKS], ["tool_execution_start", "tool_execution_end"]);
  assert.deepEqual([...NATIVE_ONLY_TOOL_HOOKS], ["tool_call", "tool_result"]);
});

// ---------------------------------------------------------------------------
// Source scan: register-hooks.ts must mirror safety concerns universally
// ---------------------------------------------------------------------------

const registerHooksSource = readFileSync(
  join(process.cwd(), "src/resources/extensions/gsd/bootstrap/register-hooks.ts"),
  "utf8",
);

/**
 * Extract the body of every `pi.on("<eventName>", ...)` registration by
 * scanning balanced parentheses from each registration site.
 */
function hookBodies(source: string, eventName: string): string[] {
  const bodies: string[] = [];
  const marker = `pi.on("${eventName}"`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    // Scan from pi.on's own opening paren so the whole registration is balanced.
    for (let i = start + "pi.on".length; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end > start, `unbalanced pi.on("${eventName}") registration`);
    bodies.push(source.slice(start, end + 1));
    from = end + 1;
  }
  return bodies;
}

test("tool_execution_start handler mirrors evidence collection and write-gate arming", () => {
  const bodies = hookBodies(registerHooksSource, "tool_execution_start");
  assert.ok(bodies.length >= 1, "register-hooks.ts must register a tool_execution_start handler");
  const merged = bodies.join("\n");

  // Evidence collection: the safety harness records the call on the universal
  // hook (deduped by toolCallId against the native-only tool_call recording).
  assert.match(merged, /safetyRecordToolCall\(/);
  assert.match(merged, /saveEvidenceToDisk\(/);

  // Write-gate (re-)arming: external engines never reach the tool_call
  // deferApprovalGate path, so the durable pending gate must be armed here.
  assert.match(merged, /hostWriteGateAdapter\.setPending\(/);
});

test("mirrored concerns also exist on the native-only tool_call side (dedup pairing)", () => {
  const bodies = hookBodies(registerHooksSource, "tool_call");
  assert.ok(bodies.length >= 1, "register-hooks.ts must register tool_call handlers");
  const merged = bodies.join("\n");
  assert.match(merged, /safetyRecordToolCall\(/);
  assert.match(merged, /deferApprovalGate\(/);
});

test("tool_execution_end handler mirrors error classification and evidence persistence", () => {
  const bodies = hookBodies(registerHooksSource, "tool_execution_end");
  assert.ok(bodies.length >= 1, "register-hooks.ts must register a tool_execution_end handler");
  const merged = bodies.join("\n");
  assert.match(merged, /recordToolInvocationError\(/);
  assert.match(merged, /safetyRecordToolResult\(/);
});

// ---------------------------------------------------------------------------
// Normalizer parity
// ---------------------------------------------------------------------------

test("canonicalHeadlessToolName matches canonicalToolName on the edge-case table", () => {
  const cases: Array<{ input: string; expected: string }> = [
    { input: "mcp__server__tool", expected: "tool" },
    { input: "mcp__gsd-workflow__gsd_status", expected: "gsd_status" },
    { input: "plain", expected: "plain" },
    { input: "ask_user_questions", expected: "ask_user_questions" },
    // Nested underscores: only the first server/tool delimiter splits.
    { input: "mcp__s__a__b", expected: "a__b" },
    { input: "", expected: "" },
    { input: "mcp__", expected: "mcp__" },
    // Malformed names stay unchanged (strict parser: empty server/tool → no strip).
    { input: "mcp____tool", expected: "mcp____tool" },
    { input: "mcp__server__", expected: "mcp__server__" },
  ];
  for (const { input, expected } of cases) {
    assert.equal(canonicalToolName(input), expected, `canonicalToolName(${JSON.stringify(input)})`);
    assert.equal(
      canonicalHeadlessToolName(input),
      canonicalToolName(input),
      `headless/strip parity for ${JSON.stringify(input)}`,
    );
  }
  assert.equal(canonicalHeadlessToolName(undefined), "");
});

test("canonicalWorkflowToolName = prefix strip + workflow alias resolution", () => {
  // Non-alias names behave exactly like canonicalToolName.
  for (const name of ["mcp__server__tool", "plain", "mcp__s__a__b"]) {
    assert.equal(canonicalWorkflowToolName(name), canonicalToolName(name));
  }
  // Alias names additionally resolve to the canonical workflow tool.
  assert.ok(WORKFLOW_TOOL_ALIAS_PAIRS.length > 0, "expected at least one workflow alias");
  for (const { alias, canonical } of WORKFLOW_TOOL_ALIAS_PAIRS) {
    assert.equal(canonicalWorkflowToolName(alias), canonical);
    assert.equal(canonicalWorkflowToolName(`mcp__gsd-workflow__${alias}`), canonical);
    // Plain strip must NOT resolve aliases — that distinction is the seam.
    assert.equal(canonicalToolName(alias), alias);
  }
});
