// Project/App: Open GSD
// File Purpose: Regression coverage for detached cloud runtime process timing and shutdown.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS } from "./cloud-runtime.js";
import {
  BACKGROUND_RUNTIME_READY_TIMEOUT_MS,
  backgroundRuntimeStatus,
  startBackgroundRuntime,
  stopBackgroundRuntime,
} from "./runtime-process.js";

test("background startup allows the cloud runtime's full initial reconnect window", () => {
  assert.ok(BACKGROUND_RUNTIME_READY_TIMEOUT_MS > CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS);
});

test("stop waits for the detached runtime to exit before removing its state", { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-stop-"));
  const configPath = join(root, "daemon.yaml");
  const statePath = join(root, "cloud-runtime.json");
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));process.send?.('ready');setInterval(()=>{},1000)",
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("message", () => resolve());
    });
    assert.ok(child.pid);
    writeFileSync(statePath, `${JSON.stringify({ pid: child.pid, projects: [root] })}\n`);

    const startedAt = Date.now();
    assert.equal(await stopBackgroundRuntime(configPath), true);

    assert.ok(Date.now() - startedAt >= 150);
    assert.equal(existsSync(statePath), false);
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent starts serialize and leave only the newest runtime running", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-concurrent-start-"));
  const configPath = join(root, "daemon.yaml");
  const binaryPath = writeReadyRuntime(root);

  try {
    const [first, second] = await Promise.all([
      startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] }),
      startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] }),
    ]);

    assert.notEqual(first.pid, second.pid);
    assert.ok(first.pid);
    assert.equal(processIsRunning(first.pid), false);
    assert.equal(backgroundRuntimeStatus(configPath).pid, second.pid);
  } finally {
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("verbose background starts forward the flag to the runtime child", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-verbose-start-"));
  const configPath = join(root, "daemon.yaml");
  const binaryPath = writeReadyRuntime(root);

  try {
    await startBackgroundRuntime({
      binaryPath,
      configPath,
      projectDirs: [root],
      verbose: true,
    });

    const args = JSON.parse(readFileSync(join(root, "runtime-args.json"), "utf8")) as string[];
    assert.ok(args.includes("--verbose"));
  } finally {
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

function writeReadyRuntime(root: string): string {
  const binaryPath = join(root, "runtime.mjs");
  writeFileSync(binaryPath, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(root, "runtime-args.json"))}, JSON.stringify(process.argv.slice(2)));`,
    'process.on("SIGTERM", () => process.exit(0));',
    'process.send?.({ type: "ready" });',
    'setInterval(() => undefined, 1_000);',
  ].join("\n"));
  return binaryPath;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
