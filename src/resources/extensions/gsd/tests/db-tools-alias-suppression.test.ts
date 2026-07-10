// Project/App: gsd-pi
// File Purpose: Verifies GSD_ADVERTISE_TOOL_ALIASES gates alias registration on the native tool path (plan 035).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDbTools } from '../bootstrap/db-tools.ts';
import { WORKFLOW_TOOL_ALIAS_NAMES, WORKFLOW_TOOL_CONTRACTS } from '../workflow-tool-surface.ts';

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('default: only canonical names are registered, no aliases', () => {
  withEnv('GSD_ADVERTISE_TOOL_ALIASES', undefined, () => {
    const pi = makeMockPi();
    registerDbTools(pi);
    const names = new Set(pi.tools.map((tool: any) => tool.name));

    for (const alias of WORKFLOW_TOOL_ALIAS_NAMES) {
      assert.ok(!names.has(alias), `alias "${alias}" should not be registered by default`);
    }
    const registeredCanonical = WORKFLOW_TOOL_CONTRACTS
      .map((tool) => tool.canonicalName)
      .filter((name) => names.has(name));
    assert.ok(registeredCanonical.length > 0, 'canonical tools should still be registered');
  });
});

test('GSD_ADVERTISE_TOOL_ALIASES=1: aliases are registered with the "(alias for ...)" description suffix', () => {
  withEnv('GSD_ADVERTISE_TOOL_ALIASES', '1', () => {
    const pi = makeMockPi();
    registerDbTools(pi);
    const toolByName = new Map<string, any>(pi.tools.map((tool: any) => [tool.name, tool]));

    const registeredAliases = WORKFLOW_TOOL_ALIAS_NAMES.filter((alias) => toolByName.has(alias));
    assert.ok(registeredAliases.length > 0, 'at least one alias should be registered when opted in');

    for (const alias of registeredAliases) {
      const aliasTool = toolByName.get(alias);
      assert.ok(
        aliasTool.description.includes('(alias for '),
        `alias "${alias}" description should include "(alias for ...)"`,
      );
    }
  });
});
