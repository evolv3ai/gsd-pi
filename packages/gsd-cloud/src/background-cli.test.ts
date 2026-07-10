// Project/App: Open GSD
// File Purpose: Acceptance coverage for the detached gsd-cloud runtime lifecycle.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { saveCloudConfig } from "./cloud-config.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(packageRoot, "bin", "gsd-cloud.js");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface TestGateway {
  baseUrl: string;
  hello: Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

function runCli(args: string[], cwd: string, timeoutMs = 5_000): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, GSD_CLOUD_PROJECTS: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`gsd-cloud did not return within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stdout, stderr });
    });
  });
}

async function createTestGateway(deviceFlow = false): Promise<TestGateway> {
  let baseUrl = "";
  const server = createServer((req, res) => {
    if (!deviceFlow) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/device/code") {
      res.end(JSON.stringify({
        userCode: "TEST-CODE",
        deviceCode: "test-device",
        verificationUriComplete: `${baseUrl}/approve-device?code=TEST-CODE`,
        expiresIn: 30,
      }));
      return;
    }
    if (req.url === "/api/device/token") {
      res.end(JSON.stringify({
        status: "approved",
        token: "test",
        runtimeId: "fixture-runtime",
        gateway_url: baseUrl,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  let helloTimeout: ReturnType<typeof setTimeout>;
  const hello = new Promise<Record<string, unknown>>((resolveHello, reject) => {
    helloTimeout = setTimeout(() => reject(new Error("background runtime did not advertise its project")), 8_000);
    wss.once("connection", (socket) => {
      socket.once("message", (data) => {
        clearTimeout(helloTimeout);
        resolveHello(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      });
    });
  });

  return {
    baseUrl,
    hello,
    close: async () => {
      clearTimeout(helloTimeout);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolveClose) => wss.close(() => server.close(() => resolveClose())));
    },
  };
}

test("connect returns while a background runtime advertises the selected project", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-background-"));
  const projectDir = join(root, "project");
  const expectedProjectDir = join(realpathSync(root), "project");
  const configPath = join(root, "daemon.yaml");
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });

  const gateway = await createTestGateway();

  saveCloudConfig(configPath, {
    gateway_url: gateway.baseUrl,
    device_token: "test",
    runtime_id: "fixture-runtime",
    enabled: true,
  });

  try {
    const connect = await runCli(["connect", "--config", configPath], projectDir);
    assert.equal(connect.code, 0, connect.stderr);
    assert.match(connect.stdout, /connected in the background/i);

    const message = await gateway.hello;
    assert.equal(message.type, "hello");
    const projects = message.projects as Array<{ path: string }>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.path, expectedProjectDir);

    const status = await runCli(["status", "--config", configPath], projectDir);
    assert.equal(status.code, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout) as {
      background?: { running?: boolean; pid?: number | null };
      projects?: string[];
    };
    assert.equal(statusBody.background?.running, true);
    assert.equal(typeof statusBody.background?.pid, "number");
    assert.deepEqual(statusBody.projects, [expectedProjectDir]);
  } finally {
    await runCli(["disconnect", "--config", configPath], projectDir).catch(() => undefined);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("login returns after approval and keeps the selected project connected", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-login-background-"));
  const projectDir = join(root, "project");
  const expectedProjectDir = join(realpathSync(root), "project");
  const configPath = join(root, "daemon.yaml");
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  const gateway = await createTestGateway(true);

  try {
    const login = await runCli([
      "login",
      "--gateway", gateway.baseUrl,
      "--config", configPath,
    ], projectDir, 12_000);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Authorization approved!/);
    assert.match(login.stdout, /connected in the background/i);

    const message = await gateway.hello;
    const projects = message.projects as Array<{ path: string }>;
    assert.deepEqual(projects.map((project) => project.path), [expectedProjectDir]);

    const disconnect = await runCli(["disconnect", "--config", configPath], projectDir);
    assert.equal(disconnect.code, 0, disconnect.stderr);
    const status = await runCli(["status", "--config", configPath], projectDir);
    const statusBody = JSON.parse(status.stdout) as {
      configured?: boolean;
      background?: { running?: boolean };
    };
    assert.equal(statusBody.configured, false);
    assert.equal(statusBody.background?.running, false);
  } finally {
    await runCli(["disconnect", "--config", configPath], projectDir).catch(() => undefined);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});
