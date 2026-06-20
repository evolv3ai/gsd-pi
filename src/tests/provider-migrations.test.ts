import test from "node:test"
import assert from "node:assert/strict"
import {
  hasDirectAnthropicApiKey,
  hasDirectGoogleApiKey,
  hasGeminiCliExternalAuth,
  migrateAnthropicDefaultToClaudeCode,
  migrateGeminiCliDefaultToAntigravity,
  shouldMigrateAnthropicToClaudeCode,
  shouldMigrateGeminiCliToAntigravity,
} from "../provider-migrations.ts"

function makeAuthStorage(credentials: unknown[], provider = "anthropic") {
  return {
    getCredentialsForProvider(id: string) {
      return id === provider ? credentials : []
    },
    set() {},
  }
}

function makeGeminiAuthStorage(geminiCredentials: unknown[], googleCredentials: unknown[] = []) {
  return {
    getCredentialsForProvider(id: string) {
      if (id === "google-gemini-cli") return geminiCredentials
      if (id === "google") return googleCredentials
      return []
    },
    set() {},
  }
}

test("hasDirectAnthropicApiKey detects non-empty auth storage keys", () => {
  assert.equal(
    hasDirectAnthropicApiKey(
      makeAuthStorage([{ type: "api_key", key: "sk-ant-test" }]) as any,
      {} as NodeJS.ProcessEnv,
    ),
    true,
  )
})

test("hasDirectAnthropicApiKey ignores empty placeholder keys", () => {
  assert.equal(
    hasDirectAnthropicApiKey(
      makeAuthStorage([{ type: "api_key", key: "" }]) as any,
      {} as NodeJS.ProcessEnv,
    ),
    false,
  )
})

test("hasDirectAnthropicApiKey detects ANTHROPIC_API_KEY env fallback", () => {
  assert.equal(
    hasDirectAnthropicApiKey(
      makeAuthStorage([]) as any,
      { ANTHROPIC_API_KEY: "sk-ant-env" } as NodeJS.ProcessEnv,
    ),
    true,
  )
})

test("shouldMigrateAnthropicToClaudeCode blocks migration for direct-key users", () => {
  assert.equal(
    shouldMigrateAnthropicToClaudeCode({
      authStorage: makeAuthStorage([{ type: "api_key", key: "sk-ant-test" }]) as any,
      isClaudeCodeReady: true,
      defaultProvider: "anthropic",
      env: {} as NodeJS.ProcessEnv,
    }),
    false,
  )
})

test("shouldMigrateAnthropicToClaudeCode allows OAuth-only anthropic users", () => {
  assert.equal(
    shouldMigrateAnthropicToClaudeCode({
      authStorage: makeAuthStorage([{ type: "oauth" }]) as any,
      isClaudeCodeReady: true,
      defaultProvider: "anthropic",
      env: {} as NodeJS.ProcessEnv,
    }),
    true,
  )
})

test("shouldMigrateAnthropicToClaudeCode stays off for other providers", () => {
  let checkedClaudeCode = false
  assert.equal(
    shouldMigrateAnthropicToClaudeCode({
      authStorage: makeAuthStorage([{ type: "oauth" }]) as any,
      isClaudeCodeReady: () => {
        checkedClaudeCode = true
        return true
      },
      defaultProvider: "openai",
      env: {} as NodeJS.ProcessEnv,
    }),
    false,
  )
  assert.equal(checkedClaudeCode, false)
})

test("shouldMigrateAnthropicToClaudeCode skips Claude probe for direct-key users", () => {
  let checkedClaudeCode = false
  assert.equal(
    shouldMigrateAnthropicToClaudeCode({
      authStorage: makeAuthStorage([{ type: "api_key", key: "sk-ant-test" }]) as any,
      isClaudeCodeReady: () => {
        checkedClaudeCode = true
        return true
      },
      defaultProvider: "anthropic",
      env: {} as NodeJS.ProcessEnv,
    }),
    false,
  )
  assert.equal(checkedClaudeCode, false)
})

test("migrateAnthropicDefaultToClaudeCode switches to matching claude-code model", () => {
  let saved: { provider: string; modelId: string } | undefined
  const migrated = migrateAnthropicDefaultToClaudeCode({
    authStorage: makeAuthStorage([{ type: "oauth" }]) as any,
    isClaudeCodeReady: true,
    settingsManager: {
      getDefaultProvider: () => "anthropic",
      getDefaultModel: () => "claude-sonnet-4-6",
      setDefaultModelAndProvider: (provider, modelId) => {
        saved = { provider, modelId }
      },
    },
    modelRegistry: {
      getAvailable: () => [
        { provider: "claude-code", id: "claude-sonnet-4-6" },
        { provider: "openai", id: "gpt-5.4" },
      ],
    },
    env: {} as NodeJS.ProcessEnv,
  })

  assert.equal(migrated, true)
  assert.deepEqual(saved, { provider: "claude-code", modelId: "claude-sonnet-4-6" })
})

test("migrateAnthropicDefaultToClaudeCode does not switch without a claude-code model", () => {
  let called = false
  const migrated = migrateAnthropicDefaultToClaudeCode({
    authStorage: makeAuthStorage([{ type: "oauth" }]) as any,
    isClaudeCodeReady: true,
    settingsManager: {
      getDefaultProvider: () => "anthropic",
      getDefaultModel: () => "claude-sonnet-4-6",
      setDefaultModelAndProvider: () => {
        called = true
      },
    },
    modelRegistry: {
      getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }],
    },
    env: {} as NodeJS.ProcessEnv,
  })

  assert.equal(migrated, false)
  assert.equal(called, false)
})

test("hasGeminiCliExternalAuth detects external CLI sentinel", () => {
  assert.equal(
    hasGeminiCliExternalAuth(
      makeGeminiAuthStorage([{ type: "api_key", key: "cli" }]) as any,
    ),
    true,
  )
  assert.equal(
    hasGeminiCliExternalAuth(
      makeGeminiAuthStorage([{ type: "oauth", token: "nope" }]) as any,
    ),
    false,
  )
})

test("hasDirectGoogleApiKey detects GEMINI_API_KEY env fallback", () => {
  assert.equal(
    hasDirectGoogleApiKey(makeGeminiAuthStorage([]) as any, { GEMINI_API_KEY: "key" } as NodeJS.ProcessEnv),
    true,
  )
})

test("shouldMigrateGeminiCliToAntigravity requires external CLI auth and antigravity ready", () => {
  assert.equal(
    shouldMigrateGeminiCliToAntigravity({
      authStorage: makeGeminiAuthStorage([{ type: "api_key", key: "cli" }]) as any,
      isAntigravityReady: true,
      defaultProvider: "google-gemini-cli",
      env: {} as NodeJS.ProcessEnv,
    }),
    true,
  )
})

test("shouldMigrateGeminiCliToAntigravity stays off for other providers", () => {
  let checked = false
  assert.equal(
    shouldMigrateGeminiCliToAntigravity({
      authStorage: makeGeminiAuthStorage([{ type: "api_key", key: "cli" }]) as any,
      isAntigravityReady: () => {
        checked = true
        return true
      },
      defaultProvider: "google-antigravity",
      env: {} as NodeJS.ProcessEnv,
    }),
    false,
  )
  assert.equal(checked, false)
})

test("shouldMigrateGeminiCliToAntigravity skips when antigravity is not ready", () => {
  assert.equal(
    shouldMigrateGeminiCliToAntigravity({
      authStorage: makeGeminiAuthStorage([{ type: "api_key", key: "cli" }]) as any,
      isAntigravityReady: false,
      defaultProvider: "google-gemini-cli",
      env: {} as NodeJS.ProcessEnv,
    }),
    false,
  )
})

test("shouldMigrateGeminiCliToAntigravity blocks migration for direct Google API key users", () => {
  assert.equal(
    shouldMigrateGeminiCliToAntigravity({
      authStorage: makeGeminiAuthStorage(
        [{ type: "api_key", key: "cli" }],
        [{ type: "api_key", key: "AIza-test" }],
      ) as any,
      isAntigravityReady: true,
      defaultProvider: "google-gemini-cli",
      env: {} as NodeJS.ProcessEnv,
    }),
    false,
  )
})

test("migrateGeminiCliDefaultToAntigravity switches to antigravity default model", () => {
  let saved: { provider: string; modelId: string } | undefined
  let antigravityAuth: unknown
  const authStorage = {
    getCredentialsForProvider(id: string) {
      if (id === "google-gemini-cli") return [{ type: "api_key", key: "cli" }]
      if (id === "google") return []
      return []
    },
    set(provider: string, credential: unknown) {
      if (provider === "google-antigravity") antigravityAuth = credential
    },
  }

  const migrated = migrateGeminiCliDefaultToAntigravity({
    authStorage: authStorage as any,
    isAntigravityReady: true,
    settingsManager: {
      getDefaultProvider: () => "google-gemini-cli",
      getDefaultModel: () => "gemini-2.5-pro",
      setDefaultModelAndProvider: (provider, modelId) => {
        saved = { provider, modelId }
      },
    },
    modelRegistry: {
      getAvailable: () => [
        { provider: "google-gemini-cli", id: "gemini-2.5-pro" },
        { provider: "google-antigravity", id: "default" },
      ],
    },
    env: {} as NodeJS.ProcessEnv,
  })

  assert.equal(migrated, true)
  assert.deepEqual(saved, { provider: "google-antigravity", modelId: "default" })
  assert.deepEqual(antigravityAuth, { type: "api_key", key: "cli" })
})

test("migrateGeminiCliDefaultToAntigravity preserves model id when antigravity exposes it", () => {
  let saved: { provider: string; modelId: string } | undefined
  const migrated = migrateGeminiCliDefaultToAntigravity({
    authStorage: makeGeminiAuthStorage([{ type: "api_key", key: "cli" }]) as any,
    isAntigravityReady: true,
    settingsManager: {
      getDefaultProvider: () => "google-gemini-cli",
      getDefaultModel: () => "gemini-3-flash-preview",
      setDefaultModelAndProvider: (provider, modelId) => {
        saved = { provider, modelId }
      },
    },
    modelRegistry: {
      getAvailable: () => [
        { provider: "google-antigravity", id: "default" },
        { provider: "google-antigravity", id: "gemini-3-flash-preview" },
      ],
    },
    env: {} as NodeJS.ProcessEnv,
  })

  assert.equal(migrated, true)
  assert.deepEqual(saved, { provider: "google-antigravity", modelId: "gemini-3-flash-preview" })
})
