import type { AuthStorage } from "@gsd/pi-coding-agent"

type AnthropicMigrationDeps = {
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">
  isClaudeCodeReady: boolean | (() => boolean)
  defaultProvider: string | undefined
  env?: NodeJS.ProcessEnv
}

type MigrationModel = {
  provider: string
  id: string
}

type AnthropicDefaultMigrationDeps = {
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">
  isClaudeCodeReady: boolean | (() => boolean)
  settingsManager: {
    getDefaultProvider(): string | undefined
    getDefaultModel(): string | undefined
    setDefaultModelAndProvider(provider: string, modelId: string): void
  }
  modelRegistry: {
    getAvailable(): MigrationModel[]
  }
  env?: NodeJS.ProcessEnv
}

export function hasDirectAnthropicApiKey(
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((env.ANTHROPIC_API_KEY ?? "").trim()) {
    return true
  }

  return authStorage.getCredentialsForProvider("anthropic").some((credential: { type?: string; key?: string }) =>
    credential?.type === "api_key" && typeof credential?.key === "string" && credential.key.trim().length > 0,
  )
}

export function shouldMigrateAnthropicToClaudeCode({
  authStorage,
  isClaudeCodeReady,
  defaultProvider,
  env = process.env,
}: AnthropicMigrationDeps): boolean {
  if (defaultProvider !== "anthropic") {
    return false
  }

  if (hasDirectAnthropicApiKey(authStorage, env)) {
    return false
  }

  return typeof isClaudeCodeReady === "function" ? isClaudeCodeReady() : isClaudeCodeReady
}

export function migrateAnthropicDefaultToClaudeCode({
  authStorage,
  isClaudeCodeReady,
  settingsManager,
  modelRegistry,
  env = process.env,
}: AnthropicDefaultMigrationDeps): boolean {
  const defaultProvider = settingsManager.getDefaultProvider()
  if (!shouldMigrateAnthropicToClaudeCode({ authStorage, isClaudeCodeReady, defaultProvider, env })) {
    return false
  }

  const defaultModel = settingsManager.getDefaultModel()
  const target =
    modelRegistry.getAvailable().find((model) => model.provider === "claude-code" && model.id === defaultModel) ||
    modelRegistry.getAvailable().find((model) => model.provider === "claude-code")

  if (!target) {
    return false
  }

  settingsManager.setDefaultModelAndProvider(target.provider, target.id)
  return true
}

type GeminiCliMigrationDeps = {
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">
  isAntigravityReady: boolean | (() => boolean)
  defaultProvider: string | undefined
  env?: NodeJS.ProcessEnv
}

type GeminiCliDefaultMigrationDeps = {
  authStorage: Pick<AuthStorage, "getCredentialsForProvider" | "set">
  isAntigravityReady: boolean | (() => boolean)
  settingsManager: {
    getDefaultProvider(): string | undefined
    getDefaultModel(): string | undefined
    setDefaultModelAndProvider(provider: string, modelId: string): void
  }
  modelRegistry: {
    getAvailable(): MigrationModel[]
  }
  env?: NodeJS.ProcessEnv
}

export function hasGeminiCliExternalAuth(
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">,
): boolean {
  return authStorage.getCredentialsForProvider("google-gemini-cli").some(
    (credential: { type?: string; key?: string }) =>
      credential?.type === "api_key" && credential?.key === "cli",
  )
}

export function hasDirectGoogleApiKey(
  authStorage: Pick<AuthStorage, "getCredentialsForProvider">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? "").trim()) {
    return true
  }

  return authStorage.getCredentialsForProvider("google").some(
    (credential: { type?: string; key?: string }) =>
      credential?.type === "api_key" && typeof credential?.key === "string" && credential.key.trim().length > 0,
  )
}

export function shouldMigrateGeminiCliToAntigravity({
  authStorage,
  isAntigravityReady,
  defaultProvider,
  env = process.env,
}: GeminiCliMigrationDeps): boolean {
  if (defaultProvider !== "google-gemini-cli") {
    return false
  }

  if (!hasGeminiCliExternalAuth(authStorage)) {
    return false
  }

  if (hasDirectGoogleApiKey(authStorage, env)) {
    return false
  }

  return typeof isAntigravityReady === "function" ? isAntigravityReady() : isAntigravityReady
}

export function migrateGeminiCliDefaultToAntigravity({
  authStorage,
  isAntigravityReady,
  settingsManager,
  modelRegistry,
  env = process.env,
}: GeminiCliDefaultMigrationDeps): boolean {
  const defaultProvider = settingsManager.getDefaultProvider()
  if (!shouldMigrateGeminiCliToAntigravity({ authStorage, isAntigravityReady, defaultProvider, env })) {
    return false
  }

  const defaultModel = settingsManager.getDefaultModel()
  const antigravityModels = modelRegistry.getAvailable().filter((model) => model.provider === "google-antigravity")
  const target =
    (defaultModel
      ? antigravityModels.find((model) => model.id === defaultModel)
      : undefined) ||
    antigravityModels.find((model) => model.id === "default") ||
    antigravityModels[0]

  if (!target) {
    return false
  }

  authStorage.set("google-antigravity", { type: "api_key", key: "cli" })
  settingsManager.setDefaultModelAndProvider(target.provider, target.id)
  process.stderr.write(
    "[gsd] Migrated default provider google-gemini-cli → google-antigravity (Gemini CLI no longer supported for individuals)\n",
  )
  return true
}
