import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudRuntime } from "./cloud-runtime.js";

function makeRuntime(): CloudRuntime {
  return new CloudRuntime(
    { gateway_url: "ws://127.0.0.1:1", device_token: "fixture", runtime_id: "runtime" },
    { execute: async () => ({}), advertisedProjects: async () => [] } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
  );
}

test("cloud runtime ignores stale socket close events after replacement", () => {
  const runtime = makeRuntime();
  const staleSocket = {};
  const activeSocket = { close: () => undefined };
  const heartbeat = setInterval(() => undefined, 30_000);
  try {
    Object.assign(runtime as unknown as { socket: unknown; heartbeat: ReturnType<typeof setInterval> }, {
      socket: activeSocket,
      heartbeat,
    });

    (runtime as unknown as { handleSocketClose: (socket: unknown) => void }).handleSocketClose(staleSocket);

    const state = runtime as unknown as {
      socket: unknown;
      heartbeat: ReturnType<typeof setInterval> | undefined;
      reconnect: ReturnType<typeof setTimeout> | undefined;
    };
    assert.equal(state.socket, activeSocket);
    assert.equal(state.heartbeat, heartbeat);
    assert.equal(state.reconnect, undefined);
  } finally {
    clearInterval(heartbeat);
    runtime.stop();
  }
});
