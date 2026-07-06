import { spawn } from "node:child_process";
import type { Spawner } from "./headless-runner.js";

export const realSpawner: Spawner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      env: opts.env,
      timeout: opts.timeoutMs,
      // "ignore" sentinel: close stdin so an unauthenticated/interactive CLI
      // can't block waiting on input instead of failing fast.
      stdio: opts.stdin === "ignore" ? ["ignore", "pipe", "pipe"] : undefined,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    if (opts.stdin !== undefined && opts.stdin !== "ignore") {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
  });
