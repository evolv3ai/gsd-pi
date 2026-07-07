// Project/App: Open GSD
// File Purpose: Regression tests for postJsonToValidatedGateway's request
// timeout — a hung gateway must reject rather than hang the pairing/device flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { postJsonToValidatedGateway } from "./cloud-config.js";

// Start a loopback server, returning its base URL; skips the test under sandbox EPERM.
async function listenLoopback(
  t: { skip: (msg: string) => void },
  handler: RequestListener,
): Promise<{ baseUrl: string; close: () => Promise<void> } | null> {
  const server = createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("loopback listen is blocked in this sandbox");
      return null;
    }
    throw err;
  }
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

test("postJsonToValidatedGateway rejects when the gateway never responds", async (t) => {
  // Handler that accepts the request but never sends a response — the hung-server case.
  const server = await listenLoopback(t, () => { /* never call res.end */ });
  if (!server) return;
  try {
    await assert.rejects(
      postJsonToValidatedGateway(new URL(`${server.baseUrl}/x`), {}, 200),
      /timed out after 200ms/,
    );
  } finally {
    await server.close();
  }
});

test("postJsonToValidatedGateway resolves a fast healthy response before the timeout", async (t) => {
  const server = await listenLoopback(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  if (!server) return;
  try {
    const body = await postJsonToValidatedGateway(new URL(`${server.baseUrl}/x`), {}, 200);
    assert.deepEqual(body, {});
  } finally {
    await server.close();
  }
});
