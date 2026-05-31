import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import { GSD_WORKFLOW_MCP_SERVER_NAME } from "../mcp-project-config.ts";
import { prepareWorkflowMcpForProject, shouldAutoPrepareWorkflowMcp } from "../workflow-mcp-auto-prep.ts";

test("shouldAutoPrepareWorkflowMcp enables prep for externalCli local transport", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "claude-code", baseUrl: "local://claude-code" },
    modelRegistry: {
      getProviderAuthMode: () => "externalCli",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, true);
});

test("shouldAutoPrepareWorkflowMcp stays disabled for non-Claude active provider even when claude-code is ready", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: (provider: string) => provider === "claude-code",
    },
  });

  assert.equal(result, false);
});

test("shouldAutoPrepareWorkflowMcp stays disabled for non-Claude active provider even when claude-code is registered", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: (provider: string) => provider === "claude-code" ? "externalCli" : "apiKey",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, false);
});

test("shouldAutoPrepareWorkflowMcp stays disabled when neither transport nor provider readiness match", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: () => false,
    },
  });

  assert.equal(result, false);
});

test("prepareWorkflowMcpForProject warns with /gsd mcp init guidance when prep fails", () => {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" | "success" }> = [];
  const result = prepareWorkflowMcpForProject(
    {
      model: { provider: "claude-code", baseUrl: "local://claude-code" },
      modelRegistry: {
        getProviderAuthMode: () => "externalCli",
        isProviderRequestReady: () => true,
      },
      ui: {
        notify: (message: string, level?: "info" | "warning" | "error" | "success") => {
          notifications.push({ message, level: level ?? "info" });
        },
      },
    },
    "/",
  );

  assert.equal(result, null);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /Please run \/gsd mcp init \./);
});

test("before_agent_start auto-prepares project workflow MCP for Claude Code CLI", async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-before-agent-"));
  const originalCwd = process.cwd();
  const notifications: string[] = [];
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
  };

  t.after(() => {
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  process.chdir(projectRoot);
  registerHooks(pi as any, []);

  const beforeAgentStart = handlers.get("before_agent_start")?.[0];
  assert.ok(beforeAgentStart, "before_agent_start hook should be registered");

  await beforeAgentStart(
    { prompt: "hello", systemPrompt: "base" },
    {
      cwd: projectRoot,
      model: { provider: "claude-code", baseUrl: "local://claude-code" },
      modelRegistry: {
        getProviderAuthMode: () => "externalCli",
        isProviderRequestReady: () => true,
      },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setWidget() {},
      },
    },
  );

  const configPath = join(projectRoot, ".mcp.json");
  assert.equal(existsSync(configPath), true, "Claude Code CLI turns should create project MCP config");

  const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
    mcpServers?: Record<string, unknown>;
  };
  assert.ok(parsed.mcpServers?.[GSD_WORKFLOW_MCP_SERVER_NAME]);
  assert.match(notifications.join("\n"), /Claude Code MCP prepared/);
});
