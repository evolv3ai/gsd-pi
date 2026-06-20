/**
 * OAuth/subscription vs pay-per-token API routing for bare model IDs.
 *
 * When the same model ID (e.g. gpt-5.5) exists on multiple providers, resolveModelId
 * must prefer subscription/OAuth routes over platform API keys.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MODELS } from "../../../../../packages/pi-ai/dist/models.generated.js";
import {
  BARE_ID_SUBSCRIPTION_PROVIDER_PRECEDENCE,
  resolveModelId,
} from "../auto-model-selection.js";

type ModelRef = { id: string; provider: string };

function modelsForProviders(modelId: string, providers: string[]): ModelRef[] {
  return providers.map((provider) => ({ id: modelId, provider }));
}

/** Table-driven precedence cases — one row per conflict shape, not per model ID. */
const PRECEDENCE_CASES: Array<{
  label: string;
  modelId: string;
  providers: string[];
  expected: string;
  currentProvider?: string;
}> = [
  {
    label: "ChatGPT OAuth beats OpenAI API (gpt-5.5)",
    modelId: "gpt-5.5",
    providers: ["openai", "openai-codex"],
    expected: "openai-codex",
  },
  {
    label: "Codex beats Copilot beats OpenAI API (gpt-5.5 triple)",
    modelId: "gpt-5.5",
    providers: ["openai", "github-copilot", "openai-codex"],
    expected: "openai-codex",
  },
  {
    label: "Copilot OAuth beats OpenAI API when no Codex (gpt-5.5)",
    modelId: "gpt-5.5",
    providers: ["openai", "github-copilot"],
    expected: "github-copilot",
  },
  {
    label: "Copilot OAuth beats OpenAI API (gpt-5-mini)",
    modelId: "gpt-5-mini",
    providers: ["openai", "github-copilot"],
    expected: "github-copilot",
  },
  {
    label: "Anthropic beats Copilot for Claude (claude-sonnet-4-6)",
    modelId: "claude-sonnet-4-6",
    providers: ["anthropic", "github-copilot"],
    expected: "anthropic",
  },
  {
    label: "Copilot beats Google API for Gemini (gemini-2.5-pro)",
    modelId: "gemini-2.5-pro",
    providers: ["google", "github-copilot"],
    expected: "github-copilot",
  },
  {
    label: "Antigravity beats Gemini CLI beats Google API (gemini-2.5-pro)",
    modelId: "gemini-2.5-pro",
    providers: ["google", "google-gemini-cli", "google-antigravity"],
    expected: "google-antigravity",
  },
  {
    label: "Gemini CLI beats Google API (gemini-2.5-pro)",
    modelId: "gemini-2.5-pro",
    providers: ["google", "google-gemini-cli"],
    expected: "google-gemini-cli",
  },
  {
    label: "Antigravity beats Copilot beats Google API",
    modelId: "gemini-2.5-pro",
    providers: ["google", "github-copilot", "google-antigravity"],
    expected: "google-antigravity",
  },
  {
    label: "Gemini CLI beats Copilot beats Google API",
    modelId: "gemini-2.5-pro",
    providers: ["google", "github-copilot", "google-gemini-cli"],
    expected: "google-gemini-cli",
  },
  {
    label: "Session provider still wins (openai-codex explicit)",
    modelId: "gpt-5.5",
    providers: ["openai", "openai-codex", "github-copilot"],
    expected: "github-copilot",
    currentProvider: "github-copilot",
  },
  {
    label: "claude-code session beats anthropic (#3772)",
    modelId: "claude-sonnet-4-6",
    providers: ["anthropic", "claude-code"],
    expected: "claude-code",
    currentProvider: "claude-code",
  },
];

for (const row of PRECEDENCE_CASES) {
  test(`resolveModelId precedence: ${row.label}`, () => {
    const available = modelsForProviders(row.modelId, row.providers);
    const result = resolveModelId(row.modelId, available, row.currentProvider);
    assert.ok(result, `expected a match for ${row.modelId}`);
    assert.equal(result.provider, row.expected);
  });
}

test("BARE_ID_SUBSCRIPTION_PROVIDER_PRECEDENCE covers known OAuth/subscription providers", () => {
  const expected = [
    "openai-codex",
    "google-antigravity",
    "google-gemini-cli",
    "anthropic",
    "github-copilot",
  ];
  assert.deepEqual([...BARE_ID_SUBSCRIPTION_PROVIDER_PRECEDENCE], expected);
});

test("every catalog overlap with OAuth/subscription + API resolves to subscription route", () => {
  const oauthProviders = new Set(["anthropic", "github-copilot", "openai-codex"]);
  const subscriptionCli = new Set(["google-gemini-cli", "google-antigravity", "claude-code"]);
  const apiPayPerToken = new Set(["openai", "google", "azure-openai-responses"]);

  const byId = new Map<string, Set<string>>();
  for (const [provider, models] of Object.entries(MODELS)) {
    for (const id of Object.keys(models)) {
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id)!.add(provider);
    }
  }

  const failures: string[] = [];

  for (const [modelId, providers] of byId) {
    if (providers.size < 2) continue;

    const hasApi = [...providers].some((p) => apiPayPerToken.has(p));
    const subscriptionCandidates = [...providers].filter(
      (p) => oauthProviders.has(p) || subscriptionCli.has(p),
    );
    if (!hasApi || subscriptionCandidates.length === 0) continue;

    const testProviders = new Set<string>(subscriptionCandidates);
    for (const p of providers) {
      if (apiPayPerToken.has(p)) testProviders.add(p);
    }

    const available = modelsForProviders(modelId, [...testProviders]);
    const result = resolveModelId(modelId, available, undefined);
    if (!result) {
      failures.push(`${modelId}: no resolution among ${[...testProviders].join(", ")}`);
      continue;
    }

    const winnerIsSubscription =
      oauthProviders.has(result.provider) ||
      subscriptionCli.has(result.provider) ||
      result.provider === "anthropic";

    if (!winnerIsSubscription) {
      failures.push(
        `${modelId}: got ${result.provider}, expected subscription route among ${[...testProviders].join(", ")}`,
      );
    }
  }

  assert.equal(
    failures.length,
    0,
    `catalog overlap routing failures:\n${failures.join("\n")}`,
  );
});
