import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerPreflightTool } from "../tools/planf3_gsd_preflight.js";
import { runPreflight } from "../preflight/run.js";
import { issueApprovalToken, pendingApprovalPath } from "../preflight/approval-token.js";

// This test lives under commands/ (not tools/) deliberately: root
// package.json's test:unit:compiled globs cover planf3-gsd/commands/*.test.js
// but have no tools/ entry — a tools/ test would silently never run
// (v0.3.1 lesson).

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  details?: Record<string, unknown>;
}

interface CapturedTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
}

function captureTool(): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool(t: CapturedTool) {
      tool = t;
    },
  } as unknown as ExtensionAPI;
  registerPreflightTool(pi);
  assert.ok(tool, "tool registered");
  return tool!;
}

const CATALOG_IDS = ["claude-code/claude-fable-5", "claude-code/claude-sonnet-4-6"];

function ctxFor(tmp: string): unknown {
  return {
    cwd: tmp,
    modelRegistry: {
      getAvailable: () => CATALOG_IDS.map((id) => {
        const slash = id.indexOf("/");
        return { provider: id.slice(0, slash), id: id.slice(slash + 1) };
      }),
    },
  };
}

async function scaffold(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-pftool-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  return tmp;
}

/** approvalHash for the same projection the tool will compute (offline). */
async function currentApprovalHash(tmp: string): Promise<string> {
  const run = await runPreflight({
    projectRoot: tmp,
    htmlPath: null,
    offline: true,
    ping: false,
    catalog: { ids: () => CATALOG_IDS },
    orchestrator: null,
  });
  return run.approvalHash;
}

describe("planf3_gsd_preflight tool sign-off hardening (F5.1-2)", () => {
  test("signOff:true without approvalToken → isError naming the console token flow; nothing written", async () => {
    const tmp = await scaffold();
    const tool = captureTool();
    const res = await tool.execute("t1", { signOff: true, offline: true }, undefined, undefined, ctxFor(tmp));
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /approval token/);
    await assert.rejects(access(join(tmp, "specs", "PRESETS.md")), "no PRESETS record may be created");
  });

  test("signOff:true with a fabricated token → isError; pending record untouched", async () => {
    const tmp = await scaffold();
    const hash = await currentApprovalHash(tmp);
    await issueApprovalToken(tmp, hash);
    const tool = captureTool();
    const res = await tool.execute("t2", { signOff: true, offline: true, approvalToken: "0000000000" }, undefined, undefined, ctxFor(tmp));
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /does not match/);
    await access(pendingApprovalPath(tmp)); // still pending — human's token still valid
  });

  test("signOff:true with the real human token signs off", async () => {
    const tmp = await scaffold();
    const hash = await currentApprovalHash(tmp);
    const token = await issueApprovalToken(tmp, hash);
    const tool = captureTool();
    const res = await tool.execute("t3", { signOff: true, offline: true, approvalToken: token }, undefined, undefined, ctxFor(tmp));
    assert.ok(!res.isError, `expected success, got: ${res.content[0]?.text}`);
    assert.match(res.content[0].text, /Signed off/);
    await access(join(tmp, "specs", "PRESETS.md"));
  });

  test("a plain (non-signOff) tool run never mints or leaks a token", async () => {
    const tmp = await scaffold();
    const tool = captureTool();
    const res = await tool.execute("t4", { offline: true }, undefined, undefined, ctxFor(tmp));
    assert.ok(!res.isError);
    await assert.rejects(access(pendingApprovalPath(tmp)), "tool surface must not issue tokens");
    assert.ok(!/approval token:/i.test(res.content[0].text), "tool output must not carry a token line");
  });
});
