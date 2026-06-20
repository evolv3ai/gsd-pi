// Project/App: gsd-pi
// File Purpose: Verifies canonical and alias DB tool registration plus legacy alias telemetry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDbTools } from '../bootstrap/db-tools.ts';
import { getLegacyTelemetry, resetLegacyTelemetry } from '../legacy-telemetry.ts';
import {
  WORKFLOW_TOOL_ALIAS_PAIRS,
  WORKFLOW_TOOL_CONTRACTS,
} from '../workflow-tool-surface.ts';


// ─── Mock PI ──────────────────────────────────────────────────────────────────

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

// ─── Registration count ──────────────────────────────────────────────────────

console.log('\n── Tool naming: registration count ──');

const pi = makeMockPi();
registerDbTools(pi);
const toolByName = new Map<string, any>(pi.tools.map((tool: any) => [tool.name, tool]));
const registeredCanonicalNames = new Set<string>(
  WORKFLOW_TOOL_CONTRACTS
    .map((tool) => tool.canonicalName)
    .filter((name) => toolByName.has(name)),
);
const RENAME_MAP = WORKFLOW_TOOL_ALIAS_PAIRS.filter(({ canonical }) =>
  registeredCanonicalNames.has(canonical),
);
const STANDALONE_TOOLS = WORKFLOW_TOOL_CONTRACTS
  .filter((tool) => registeredCanonicalNames.has(tool.canonicalName) && tool.aliases.length === 0)
  .map((tool) => tool.canonicalName);
const expectedRegisteredNames = [
  ...STANDALONE_TOOLS,
  ...RENAME_MAP.flatMap(({ canonical, alias }) => [canonical, alias]),
].sort();

assert.equal(pi.tools.length, toolByName.size, 'Tool registration should not produce duplicate names');
assert.deepStrictEqual(
  [...toolByName.keys()].sort(),
  expectedRegisteredNames,
  'Should register only workflow surface tools and their declared aliases',
);

for (const name of STANDALONE_TOOLS) {
  assert.ok(toolByName.has(name), `Standalone tool "${name}" should be registered`);
}

// ─── Both names exist for each pair ──────────────────────────────────────────

console.log('\n── Tool naming: canonical and alias names exist ──');

for (const { canonical, alias } of RENAME_MAP) {
  const canonicalTool = toolByName.get(canonical);
  const aliasTool = toolByName.get(alias);

  assert.ok(canonicalTool !== undefined, `Canonical tool "${canonical}" should be registered`);
  assert.ok(aliasTool !== undefined, `Alias tool "${alias}" should be registered`);
}

// ─── Execute function wrapping ───────────────────────────────────────────────

console.log('\n── Tool naming: alias execute wrapper ──');

for (const { canonical, alias } of RENAME_MAP) {
  const canonicalTool = toolByName.get(canonical);
  const aliasTool = toolByName.get(alias);

  if (canonicalTool && aliasTool) {
    assert.ok(
      canonicalTool.execute !== aliasTool.execute,
      `"${alias}" should wrap "${canonical}" so alias usage can be counted`,
    );
  }
}

test("alias execute increments legacy MCP alias telemetry before delegating", async () => {
  const canonicalTool = toolByName.get("gsd_decision_save");
  const aliasTool = toolByName.get("gsd_save_decision");
  assert.ok(canonicalTool);
  assert.ok(aliasTool);

  const originalCanonicalExecute = canonicalTool.execute;
  try {
    resetLegacyTelemetry();
    let delegated = false;
    canonicalTool.execute = async () => {
      delegated = true;
      return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
    };

    await aliasTool.execute("call-1", {}, undefined, undefined, undefined);

    assert.equal(delegated, true);
    assert.equal(getLegacyTelemetry()["legacy.mcpAliasUsed"], 1);
  } finally {
    canonicalTool.execute = originalCanonicalExecute;
    resetLegacyTelemetry();
  }
});

// ─── Alias descriptions include "(alias for ...)" ───────────────────────────

console.log('\n── Tool naming: alias descriptions ──');

for (const { canonical, alias } of RENAME_MAP) {
  const aliasTool = toolByName.get(alias);

  if (aliasTool) {
    assert.ok(
      aliasTool.description.includes(`alias for ${canonical}`),
      `Alias "${alias}" description should include "alias for ${canonical}"`,
    );
  }
}

// ─── Canonical tools have proper promptGuidelines ────────────────────────────

console.log('\n── Tool naming: canonical promptGuidelines use canonical name ──');

for (const { canonical } of RENAME_MAP) {
  const canonicalTool = toolByName.get(canonical);

  if (canonicalTool) {
    const guidelinesText = canonicalTool.promptGuidelines.join(' ');
    assert.ok(
      guidelinesText.includes(canonical),
      `Canonical tool "${canonical}" promptGuidelines should reference its own name`,
    );
  }
}

// ─── Alias promptGuidelines direct to canonical ──────────────────────────────

console.log('\n── Tool naming: alias promptGuidelines redirect to canonical ──');

for (const { canonical, alias } of RENAME_MAP) {
  const aliasTool = toolByName.get(alias);

  if (aliasTool) {
    const guidelinesText = aliasTool.promptGuidelines.join(' ');
    assert.ok(
      guidelinesText.includes(`Alias for ${canonical}`),
      `Alias "${alias}" promptGuidelines should say "Alias for ${canonical}"`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
