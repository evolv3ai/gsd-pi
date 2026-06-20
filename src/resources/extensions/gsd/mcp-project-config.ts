import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GSD_BROWSER_MCP_SERVER_NAME,
  resolveBundledGsdBrowserCliPath,
  resolveGsdBrowserMcpLaunchConfig,
} from "../shared/gsd-browser-cli.js";
import { assertSafeDirectory } from "./validate-directory.js";
import { detectWorkflowMcpLaunchConfig } from "./workflow-mcp.js";

export const GSD_WORKFLOW_MCP_SERVER_NAME = "gsd-workflow";
export { GSD_BROWSER_MCP_SERVER_NAME, resolveBundledGsdBrowserCliPath };

export interface ProjectMcpServerConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
}

export interface EnsureProjectWorkflowMcpConfigResult {
  configPath: string;
  serverName: string;
  serverNames: string[];
  status: "created" | "updated" | "unchanged";
}

interface ProjectMcpServerSpec {
  serverName: string;
  server: ProjectMcpServerConfig;
}

interface McpConfigFile {
  mcpServers?: Record<string, ProjectMcpServerConfig>;
  servers?: Record<string, ProjectMcpServerConfig>;
  [key: string]: unknown;
}

interface ClaudeCodeLocalSettingsFile {
  enabledMcpjsonServers?: unknown;
  disabledMcpjsonServers?: unknown;
  [key: string]: unknown;
}

export function resolveBundledGsdCliPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.GSD_CLI_PATH?.trim() || env.GSD_BIN_PATH?.trim();
  if (explicit) return explicit;

  const candidates = [
    resolve(fileURLToPath(new URL("../../../../scripts/dev-cli.js", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../dist/loader.js", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../loader.js", import.meta.url))),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function buildProjectWorkflowMcpServerConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectMcpServerConfig {
  return buildProjectWorkflowMcpServerSpec(projectRoot, env).server;
}

function buildProjectWorkflowMcpServerSpec(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectMcpServerSpec {
  const resolvedProjectRoot = resolve(projectRoot);
  const gsdCliPath = resolveBundledGsdCliPath(env);
  const launch = detectWorkflowMcpLaunchConfig(resolvedProjectRoot, {
    ...env,
    ...(gsdCliPath ? { GSD_CLI_PATH: gsdCliPath, GSD_BIN_PATH: gsdCliPath } : {}),
  });

  if (!launch) {
    throw new Error(
      "Unable to resolve the GSD workflow MCP server. Build this checkout or install gsd-mcp-server on PATH.",
    );
  }

  return {
    serverName: launch.name || GSD_WORKFLOW_MCP_SERVER_NAME,
    server: {
      command: launch.command,
      ...(launch.args && launch.args.length > 0 ? { args: launch.args } : {}),
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      ...(launch.env ? { env: launch.env } : {}),
    },
  };
}

function isEnvDisabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

export function buildProjectBrowserMcpServerConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectMcpServerConfig | null {
  return buildProjectBrowserMcpServerSpec(projectRoot, env)?.server ?? null;
}

function buildProjectBrowserMcpServerSpec(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectMcpServerSpec | null {
  if (isEnvDisabled(env.GSD_BROWSER_MCP_ENABLED)) return null;

  const launch = resolveGsdBrowserMcpLaunchConfig(projectRoot, env);

  return {
    serverName: launch.serverName,
    server: {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      ...(launch.env ? { env: launch.env } : {}),
    },
  };
}

export function buildProjectGsdMcpServers(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  servers: Record<string, ProjectMcpServerConfig>;
  workflowServerName: string;
  browserServerName: string | undefined;
} {
  const workflow = buildProjectWorkflowMcpServerSpec(projectRoot, env);
  const browser = buildProjectBrowserMcpServerSpec(projectRoot, env);
  const servers = Object.fromEntries(
    [workflow, browser].filter((spec): spec is ProjectMcpServerSpec => Boolean(spec))
      .map((spec) => [spec.serverName, spec.server]),
  );
  return {
    servers,
    workflowServerName: workflow.serverName,
    browserServerName: browser?.serverName,
  };
}

function readExistingConfig(configPath: string): McpConfigFile {
  if (!existsSync(configPath)) return {};

  const raw = readFileSync(configPath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as McpConfigFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readExistingClaudeCodeSettings(settingsPath: string): ClaudeCodeLocalSettingsFile {
  if (!existsSync(settingsPath)) return {};

  const raw = readFileSync(settingsPath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as ClaudeCodeLocalSettingsFile;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(
      `Failed to parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function ensureClaudeCodeMcpJsonServersEnabled(
  projectRoot: string,
  serverNames: string[],
): boolean {
  const resolvedProjectRoot = resolve(projectRoot);
  assertSafeDirectory(resolvedProjectRoot);

  const targetServerNames = [...new Set(serverNames.filter((name) => name.trim().length > 0))];
  if (targetServerNames.length === 0) return false;

  const settingsDir = resolve(resolvedProjectRoot, ".claude");
  const settingsPath = resolve(settingsDir, "settings.local.json");
  const existing = readExistingClaudeCodeSettings(settingsPath);

  const enabled = Array.isArray(existing.enabledMcpjsonServers)
    ? [...existing.enabledMcpjsonServers]
    : [];
  const enabledNames = new Set(enabled.filter((value): value is string => typeof value === "string"));
  let changed = !Array.isArray(existing.enabledMcpjsonServers);

  for (const serverName of targetServerNames) {
    if (!enabledNames.has(serverName)) {
      enabled.push(serverName);
      enabledNames.add(serverName);
      changed = true;
    }
  }

  let nextDisabled = existing.disabledMcpjsonServers;
  if (Array.isArray(existing.disabledMcpjsonServers)) {
    const blockedNames = new Set(targetServerNames);
    const filtered = existing.disabledMcpjsonServers.filter((value) => !blockedNames.has(String(value)));
    if (filtered.length !== existing.disabledMcpjsonServers.length) {
      nextDisabled = filtered;
      changed = true;
    }
  }

  if (!changed) return false;

  const nextSettings: ClaudeCodeLocalSettingsFile = {
    ...existing,
    enabledMcpjsonServers: enabled,
    ...(Array.isArray(existing.disabledMcpjsonServers) ? { disabledMcpjsonServers: nextDisabled } : {}),
  };

  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf-8");
  return true;
}

export function ensureClaudeCodeMcpJsonServerEnabled(
  projectRoot: string,
  serverName: string,
): boolean {
  return ensureClaudeCodeMcpJsonServersEnabled(projectRoot, [serverName]);
}

export function ensureProjectWorkflowMcpConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): EnsureProjectWorkflowMcpConfigResult {
  const resolvedProjectRoot = resolve(projectRoot);
  assertSafeDirectory(resolvedProjectRoot);

  const configPath = resolve(resolvedProjectRoot, ".mcp.json");
  const existing = readExistingConfig(configPath);
  const { servers: desiredServers, workflowServerName } = buildProjectGsdMcpServers(resolvedProjectRoot, env);
  const previousServers = existing.mcpServers ?? {};
  const nextServers = {
    ...previousServers,
    ...desiredServers,
  };
  const desiredServerNames = Object.keys(desiredServers);

  const alreadyPresent = existsSync(configPath);
  const mcpConfigUnchanged =
    desiredServerNames.every((serverName) => (
      JSON.stringify(previousServers[serverName] ?? null)
        === JSON.stringify(desiredServers[serverName])
    ))
    && existing.mcpServers !== undefined;

  if (!mcpConfigUnchanged) {
    const nextConfig: McpConfigFile = {
      ...existing,
      mcpServers: nextServers,
    };

    writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
  }

  const localSettingsChanged = ensureClaudeCodeMcpJsonServersEnabled(resolvedProjectRoot, desiredServerNames);

  if (mcpConfigUnchanged && !localSettingsChanged) {
    return {
      configPath,
      serverName: workflowServerName,
      serverNames: desiredServerNames,
      status: "unchanged",
    };
  }

  return {
    configPath,
    serverName: workflowServerName,
    serverNames: desiredServerNames,
    status: alreadyPresent ? "updated" : "created",
  };
}
