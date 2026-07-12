import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import {
  _flushDeferredContextMaintenanceForTest,
  buildBeforeAgentStartResult,
} from "../bootstrap/system-context.ts";
import { closeDatabase, isDbAvailable } from "../gsd-db.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import {
  _resolveRuntimeContractWithReadHookForTest,
  renderRuntimeContractForSystemPrompt,
  resolveRuntimeContract,
} from "../runtime-contract.ts";
import { invalidateStateCache } from "../state.ts";

function assertContainsPath(text: string, path: string): void {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(text, new RegExp(escapedPath));
}

async function withRuntimeProject(
  run: (base: string, ctx: ExtensionContext) => Promise<void>,
): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-runtime-contract-")));
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;

  mkdirSync(join(base, ".gsd"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "ignore" });
  process.chdir(base);
  process.env.GSD_HOME = join(base, ".test-home", ".gsd");
  _clearGsdRootCache();
  clearGSDPreferencesCache();

  const ctx = {
    cwd: base,
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;

  try {
    await run(base, ctx);
  } finally {
    await _flushDeferredContextMaintenanceForTest(base);
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    clearGSDPreferencesCache();
    _clearGsdRootCache();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(base, { recursive: true, force: true });
  }
}

test("injects the default project-local runtime contract into agent context", async () => {
  await withRuntimeProject(async (base, ctx) => {
    const contractDir = join(base, "script", "local-runtime");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "AGENT.md"), "# Runtime rules\n", "utf-8");
    writeFileSync(join(contractDir, "README.md"), "# Local runtime\n\n## How to use\n", "utf-8");
    writeFileSync(join(contractDir, "runtime.mjs"), "export {};\n", "utf-8");

    const result = await buildBeforeAgentStartResult(
      { prompt: "Verify the application", systemPrompt: "base system prompt" },
      ctx,
    );
    const systemPrompt = result?.systemPrompt ?? "";

    assert.match(systemPrompt, /## Project-local runtime contract/);
    assertContainsPath(systemPrompt, join(contractDir, "AGENT.md"));
    assertContainsPath(systemPrompt, join(contractDir, "README.md"));
    assertContainsPath(systemPrompt, join(contractDir, "runtime.mjs"));
    assert.match(systemPrompt, /Before starting, restarting, seeding, or tearing down/);
    assert.match(systemPrompt, /Do not start business projects directly/);
  });
});

test("uses the configured runtime contract path and entry point", async () => {
  await withRuntimeProject(async (base, ctx) => {
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "runtime:",
        "  contract:",
        "    path: ops/dev",
        "    entry: run.mjs",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
    const contractDir = join(base, "ops", "dev");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "README.md"), "# Team runtime\n", "utf-8");
    writeFileSync(join(contractDir, "run.mjs"), "export {};\n", "utf-8");
    clearGSDPreferencesCache();

    const result = await buildBeforeAgentStartResult(
      { prompt: "Run the integration stack", systemPrompt: "base system prompt" },
      ctx,
    );
    const systemPrompt = result?.systemPrompt ?? "";

    assertContainsPath(systemPrompt, join(contractDir, "README.md"));
    assertContainsPath(systemPrompt, join(contractDir, "run.mjs"));
    assert.doesNotMatch(systemPrompt, /script[\\/]local-runtime/);
  });
});

test("injects one shared runtime contract for a parent workspace", async () => {
  await withRuntimeProject(async (base, ctx) => {
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "workspace:",
        "  mode: parent",
        "  repositories:",
        "    frontend:",
        "      path: frontend",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(base, "frontend"), { recursive: true });
    const contractDir = join(base, "script", "local-runtime");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "README.md"), "# Shared stack\n", "utf-8");
    writeFileSync(join(contractDir, "runtime.mjs"), "export {};\n", "utf-8");
    clearGSDPreferencesCache();

    const result = await buildBeforeAgentStartResult(
      { prompt: "Start the workspace", systemPrompt: "base system prompt" },
      ctx,
    );
    const systemPrompt = result?.systemPrompt ?? "";

    assertContainsPath(systemPrompt, join(contractDir, "README.md"));
    assertContainsPath(systemPrompt, join(contractDir, "runtime.mjs"));
  });
});

test("leaves agent context unchanged when no runtime contract exists", async () => {
  await withRuntimeProject(async (_base, ctx) => {
    const result = await buildBeforeAgentStartResult(
      { prompt: "Plan the next task", systemPrompt: "base system prompt" },
      ctx,
    );

    assert.doesNotMatch(result?.systemPrompt ?? "", /## Project-local runtime contract/);
  });
});

test("runtime contract discovery fails closed when the project root disappears", () => {
  const missingRoot = mkdtempSync(join(tmpdir(), "gsd-runtime-contract-missing-"));
  rmSync(missingRoot, { recursive: true, force: true });

  assert.equal(resolveRuntimeContract(missingRoot), null);
});

test("discovers the repository runtime contract from a nested cwd", async () => {
  await withRuntimeProject(async (base) => {
    const nestedCwd = join(base, "packages", "web", "src");
    const contractDir = join(base, "script", "local-runtime");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "AGENT.md"), "# Root runtime rules\n", "utf-8");

    const contract = resolveRuntimeContract(nestedCwd);

    assert.equal(contract?.directory, contractDir);
    assert.equal(contract?.agentInstructions?.content, "# Root runtime rules\n");
  });
});

test("uses ctx.cwd when the host cwd has no .gsd directory", async () => {
  await withRuntimeProject(async (base, ctx) => {
    const activeRepo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-runtime-active-")));
    try {
      rmSync(join(base, ".gsd"), { recursive: true, force: true });
      mkdirSync(join(activeRepo, ".gsd"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: activeRepo, stdio: "ignore" });
      writeFileSync(
        join(activeRepo, ".gsd", "PREFERENCES.md"),
        ["---", "runtime:", "  contract:", "    path: ops/runtime", "---", ""].join("\n"),
        "utf-8",
      );
      const contractDir = join(activeRepo, "ops", "runtime");
      mkdirSync(contractDir, { recursive: true });
      writeFileSync(join(contractDir, "AGENT.md"), "# Active repository rules\n", "utf-8");
      clearGSDPreferencesCache();

      const activeCtx = { ...ctx, cwd: activeRepo } as ExtensionContext;
      const result = await buildBeforeAgentStartResult(
        { prompt: "Start the active application", systemPrompt: "base system prompt" },
        activeCtx,
      );
      const systemPrompt = result?.systemPrompt ?? "";

      assert.ok(result);
      assert.match(systemPrompt, /# Active repository rules/);
      assertContainsPath(systemPrompt, join(contractDir, "AGENT.md"));
    } finally {
      rmSync(activeRepo, { recursive: true, force: true });
    }
  });
});

test("fails closed when the contract directory changes between file reads", async () => {
  await withRuntimeProject(async (base) => {
    const contractDir = join(base, "script", "local-runtime");
    const originalContractDir = join(base, "script", "original-runtime");
    const replacementContractDir = join(base, "script", "replacement-runtime");
    mkdirSync(contractDir, { recursive: true });
    mkdirSync(replacementContractDir, { recursive: true });
    writeFileSync(join(contractDir, "AGENT.md"), "# Original agent rules\n", "utf-8");
    writeFileSync(join(contractDir, "README.md"), "# Original documentation\n", "utf-8");
    writeFileSync(join(replacementContractDir, "AGENT.md"), "# Replacement agent rules\n", "utf-8");
    writeFileSync(join(replacementContractDir, "README.md"), "# Replacement documentation\n", "utf-8");

    const contract = _resolveRuntimeContractWithReadHookForTest(base, (name) => {
      if (name !== "AGENT.md") return;
      renameSync(contractDir, originalContractDir);
      renameSync(replacementContractDir, contractDir);
    });

    assert.equal(contract, null);
  });
});

test("keeps an opened contract snapshot authoritative after directory replacement", async () => {
  await withRuntimeProject(async (base) => {
    const contractDir = join(base, "script", "local-runtime");
    const movedContractDir = join(base, "script", "original-runtime");
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-runtime-outside-")));
    try {
      mkdirSync(contractDir, { recursive: true });
      writeFileSync(join(contractDir, "AGENT.md"), "# Trusted runtime rules\n", "utf-8");
      writeFileSync(join(outsideDir, "AGENT.md"), "# Replaced outside rules\n", "utf-8");

      const contract = resolveRuntimeContract(base);
      renameSync(contractDir, movedContractDir);
      symlinkSync(outsideDir, contractDir, "dir");

      assert.equal(contract?.agentInstructions?.content, "# Trusted runtime rules\n");
      assert.notEqual(contract?.agentInstructions?.content, "# Replaced outside rules\n");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test("rejects contract document symlinks that escape the contract directory", async () => {
  await withRuntimeProject(async (base) => {
    const contractDir = join(base, "script", "local-runtime");
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-runtime-outside-")));
    try {
      mkdirSync(contractDir, { recursive: true });
      writeFileSync(join(outsideDir, "AGENT.md"), "# Outside rules\n", "utf-8");
      symlinkSync(join(outsideDir, "AGENT.md"), join(contractDir, "AGENT.md"));

      assert.equal(resolveRuntimeContract(base), null);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test("bounds and clearly delimits injected contract snapshots", async () => {
  await withRuntimeProject(async (base) => {
    const contractDir = join(base, "script", "local-runtime");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "AGENT.md"), `# Runtime rules\n${"a".repeat(20_000)}TAIL`, "utf-8");

    const runtimeBlock = renderRuntimeContractForSystemPrompt(base);

    assert.match(runtimeBlock, /<runtime-contract-snapshot/);
    assert.match(runtimeBlock, /<\/runtime-contract-snapshot>/);
    assert.match(runtimeBlock, /truncated/);
    assert.doesNotMatch(runtimeBlock, /TAIL/);
    assert.ok(runtimeBlock.length < 10_000);
  });
});
