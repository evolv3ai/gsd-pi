import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  buildClaudeRuntimeFloorAdvisory,
  CLAUDE_CODE_RUNTIME_FLOOR,
  formatClaudeRuntimeFloorAdvisory,
  inferClaudeRuntimeUpgradeCommand,
  isClaudeCodeConfigured,
  loadClaudeRuntimeSettings,
  parseClaudeRuntimeVersion,
  resolveExecutablePath,
} from "../resources/shared/claude-runtime-floor.ts";

test("parseClaudeRuntimeVersion reads the first numeric triplet", () => {
  assert.equal(parseClaudeRuntimeVersion("2.1.168 (Claude Code)"), "2.1.168");
  assert.equal(parseClaudeRuntimeVersion("claude-code 2.1.168-beta.1"), "2.1.168");
  assert.equal(parseClaudeRuntimeVersion("Claude Code version unknown"), null);
});

test("isClaudeCodeConfigured accepts provider or provider-qualified model", () => {
  assert.equal(isClaudeCodeConfigured({ defaultProvider: "claude-code" }), true);
  assert.equal(isClaudeCodeConfigured({ defaultModel: "claude-code/claude-sonnet-4-6" }), true);
  assert.equal(isClaudeCodeConfigured({ defaultProvider: "openai", defaultModel: "claude-sonnet-4-6" }), false);
});

test("loadClaudeRuntimeSettings merges project settings over global settings", () => {
  const agentDir = "/tmp/gsd-agent";
  const cwd = "/tmp/project";
  const files = new Map<string, string>([
    [join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "openai/gpt-5" })],
    [join(cwd, ".gsd", "settings.json"), JSON.stringify({ defaultProvider: "claude-code" })],
  ]);

  const settings = loadClaudeRuntimeSettings({
    agentDir,
    cwd,
    existsSync: path => files.has(String(path)),
    readFileSync: path => files.get(String(path)) ?? "",
  });

  assert.deepEqual(settings, {
    defaultProvider: "claude-code",
    defaultModel: "openai/gpt-5",
  });
});

test("resolveExecutablePath resolves the PATH candidate without running it", () => {
  const exists = (path: string) => path === "/fake/bin/claude";
  assert.equal(
    resolveExecutablePath("claude", { PATH: "/other:/fake/bin" } as NodeJS.ProcessEnv, "linux", exists as any),
    "/fake/bin/claude",
  );
});

test("buildClaudeRuntimeFloorAdvisory warns only for configured claude-code below floor", () => {
  const agentDir = "/tmp/gsd-agent";
  const files = new Map<string, string>([
    [join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "claude-code" })],
  ]);
  const advisory = buildClaudeRuntimeFloorAdvisory({
    agentDir,
    env: { PATH: "/fake/bin" } as NodeJS.ProcessEnv,
    platform: "linux",
    existsSync: path => String(path) === join(agentDir, "settings.json") || String(path) === "/fake/bin/claude",
    readFileSync: path => files.get(String(path)) ?? "",
    realpathSync: path => "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    execFileSync: () => "2.1.100 (Claude Code)",
  });

  assert.ok(advisory);
  assert.match(advisory, /detected v2\.1\.100, expected >= v2\.1\.168/);
  assert.match(advisory, /silent.*output quality|output quality.*silent/);
  assert.match(advisory, /npm install -g @anthropic-ai\/claude-code@latest/);
});

test("buildClaudeRuntimeFloorAdvisory stays silent outside high-confidence below-floor cases", () => {
  const agentDir = "/tmp/gsd-agent";
  const files = new Map<string, string>([
    [join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai" })],
  ]);
  const common = {
    agentDir,
    env: { PATH: "/fake/bin" } as NodeJS.ProcessEnv,
    platform: "linux" as NodeJS.Platform,
    existsSync: (path: string) => String(path) === join(agentDir, "settings.json") || String(path) === "/fake/bin/claude",
    readFileSync: (path: string) => files.get(String(path)) ?? "",
    realpathSync: () => "/fake/bin/claude",
  };

  assert.equal(buildClaudeRuntimeFloorAdvisory({ ...common, execFileSync: () => "2.1.100 (Claude Code)" }), null);

  files.set(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "claude-code" }));
  assert.equal(buildClaudeRuntimeFloorAdvisory({ ...common, execFileSync: () => `${CLAUDE_CODE_RUNTIME_FLOOR} (Claude Code)` }), null);
  assert.equal(buildClaudeRuntimeFloorAdvisory({ ...common, execFileSync: () => "Claude Code" }), null);
  assert.equal(buildClaudeRuntimeFloorAdvisory({ ...common, execFileSync: () => { throw new Error("missing"); } }), null);
});

test("inferClaudeRuntimeUpgradeCommand is best-effort by install path", () => {
  assert.deepEqual(
    inferClaudeRuntimeUpgradeCommand({
      displayPath: "/Users/me/.local/share/pnpm/claude",
      realPath: "/Users/me/.local/share/pnpm/global/5/node_modules/.pnpm/@anthropic-ai+claude-code@2.0.0/node_modules/@anthropic-ai/claude-code/cli.js",
    }),
    { command: "pnpm add -g @anthropic-ai/claude-code@latest", source: "pnpm" },
  );
  assert.deepEqual(
    inferClaudeRuntimeUpgradeCommand({
      displayPath: "/usr/local/bin/claude",
      realPath: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    }),
    { command: "npm install -g @anthropic-ai/claude-code@latest", source: "npm" },
  );
  assert.deepEqual(
    inferClaudeRuntimeUpgradeCommand({
      displayPath: "/opt/homebrew/bin/claude",
      realPath: "/opt/homebrew/bin/claude",
    }),
    { command: "brew upgrade claude-code", source: "homebrew" },
  );
  assert.deepEqual(
    inferClaudeRuntimeUpgradeCommand({
      displayPath: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_x64\\claude.exe",
      realPath: null,
    }, "win32"),
    { command: "winget upgrade Anthropic.ClaudeCode", source: "winget" },
  );
});

test("formatClaudeRuntimeFloorAdvisory falls back to path plus docs guidance", () => {
  const advisory = formatClaudeRuntimeFloorAdvisory({
    command: "claude",
    displayPath: "/custom/bin/claude",
    realPath: "/custom/bin/claude",
    version: "2.1.100",
  });

  assert.match(advisory, /\/custom\/bin\/claude/);
  assert.match(advisory, /using the method you installed it with/);
  assert.match(advisory, /docs\/user-docs\/claude-code-subscription\.md#upgrade-claude-code/);
});
