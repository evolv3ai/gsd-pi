import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { Spawner } from "../gsd/headless-runner.js";
import { registerBuildTool } from "../tools/planf3_gsd_build.js";

// This test lives under commands/ (not tools/) deliberately: root
// package.json's test:unit:compiled globs cover planf3-gsd/commands/*.test.js
// but have no tools/ entry — a tools/ test would silently never run
// (v0.3.1 lesson).

const here = dirname(fileURLToPath(import.meta.url));

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  details?: unknown;
}

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
}

function captureTool(overrides?: Parameters<typeof registerBuildTool>[1]): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool(t: CapturedTool) {
      tool = t;
    },
  } as unknown as ExtensionAPI;
  registerBuildTool(pi, overrides);
  assert.ok(tool, "tool registered");
  return tool!;
}

async function makeTmpPlan(): Promise<{ tmp: string; htmlPath: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-buildtool-"));
  const htmlPath = join(tmp, "minimal.html");
  await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
  return { tmp, htmlPath };
}

// Same shape as build.test.ts's auto-path fake: executing snapshot with an
// active task, so both the auto settle loop and step mode exit immediately.
function makeSpawn(calls: string[][]): Spawner {
  return async (_cmd, args) => {
    calls.push(args);
    if (args.includes("query")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: { phase: "executing", activeMilestone: { id: "M9", title: "x" }, activeTask: { id: "T1", title: "t" } },
          next: null,
          cost: { total: 0 },
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
}

describe("planf3_gsd_build tool", () => {
  test("registers under the exact tool name", () => {
    const tool = captureTool();
    assert.equal(tool.name, "planf3_gsd_build");
  });

  test("auto defaults to true; success returns the command's summary text", async () => {
    const { tmp, htmlPath } = await makeTmpPlan();
    const calls: string[][] = [];
    const tool = captureTool({ cwd: tmp, spawn: makeSpawn(calls), binary: "gsd", globalPrefsPath: join(tmp, "no-global.md") });
    const result = await tool.execute("t1", { htmlPath, force: true });
    assert.notEqual(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Built milestone M9"));
    const newMilestone = calls.find((args) => args.includes("new-milestone"));
    assert.ok(newMilestone, "new-milestone spawned");
    assert.ok(newMilestone!.includes("--auto"), "auto defaulted to true");
  });

  test("explicit auto=false (with allowUnsafeStep) is honored", async () => {
    const { tmp, htmlPath } = await makeTmpPlan();
    const calls: string[][] = [];
    const tool = captureTool({ cwd: tmp, spawn: makeSpawn(calls), binary: "gsd", globalPrefsPath: join(tmp, "no-global.md") });
    const result = await tool.execute("t2", { htmlPath, auto: false, allowUnsafeStep: true, force: true });
    assert.notEqual(result.isError, true);
    const newMilestone = calls.find((args) => args.includes("new-milestone"));
    assert.ok(newMilestone, "new-milestone spawned");
    assert.ok(!newMilestone!.includes("--auto"), "step mode honored");
  });

  test("auto=false without allowUnsafeStep → step-mode safety gate as tool error", async () => {
    const tool = captureTool();
    const result = await tool.execute("t3", { htmlPath: "whatever.html", auto: false });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Refusing headless step mode/);
  });

  test("runBuild failure surfaces friendlyError text", async () => {
    const { tmp } = await makeTmpPlan();
    const tool = captureTool({ cwd: tmp, spawn: makeSpawn([]), binary: "gsd", globalPrefsPath: join(tmp, "no-global.md") });
    const result = await tool.execute("t4", { htmlPath: join(tmp, "missing.html"), force: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Plan file not found/);
  });
});
