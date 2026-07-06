import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runAuthProbes, runModelPings, type Fetcher } from "./probes.js";
import type { Spawner } from "../gsd/headless-runner.js";

const NOW = () => "2026-07-06T04:00:00Z";
const SECRET = "sk-or-v1-DEADBEEF";

describe("runAuthProbes (tier 1)", () => {
  test("openrouter: 200 → ok, 401 → failed, network error → unreachable; never leaks the key", async () => {
    const mk = (behavior: "ok" | "reject" | "throw"): Fetcher => async (url, init) => {
      assert.match(url, /openrouter\.ai\/api\/v1\/auth\/key/);
      assert.equal(init.headers?.Authorization, `Bearer ${SECRET}`);
      if (behavior === "throw") throw new Error("ENETUNREACH");
      return { status: behavior === "ok" ? 200 : 401 };
    };
    const env = { OPENROUTER_API_KEY: SECRET };
    for (const [behavior, verdict, detail] of [
      ["ok", "ok", /HTTP 200/],
      ["reject", "failed", /HTTP 401/],
      ["throw", "unreachable", /network/i],
    ] as const) {
      const [p] = await runAuthProbes(["openrouter"], { fetcher: mk(behavior), env, now: NOW });
      assert.equal(p.target, "openrouter");
      assert.equal(p.tier, "auth");
      assert.equal(p.verdict, verdict);
      assert.match(p.detail, detail);
      assert.ok(!JSON.stringify(p).includes(SECRET), "probe output must never contain key material");
    }
  });

  test("missing env key → failed with the var NAME only", async () => {
    const [p] = await runAuthProbes(["openrouter"], { env: {}, now: NOW, fetcher: async () => ({ status: 200 }) });
    assert.equal(p.verdict, "failed");
    assert.match(p.detail, /OPENROUTER_API_KEY not set/);
  });

  test("claude-code probes via `claude auth status --json` through the spawner", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawn: Spawner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: "" };
    };
    const [p] = await runAuthProbes(["claude-code"], { spawn, env: {}, now: NOW });
    assert.deepEqual(calls[0], { cmd: "claude", args: ["auth", "status", "--json"] });
    assert.equal(p.verdict, "ok");
  });

  test("claude-code: loggedIn false or spawn failure → failed/unreachable", async () => {
    const loggedOut: Spawner = async () => ({ exitCode: 0, stdout: '{"loggedIn":false}', stderr: "" });
    const [p1] = await runAuthProbes(["claude-code"], { spawn: loggedOut, env: {}, now: NOW });
    assert.equal(p1.verdict, "failed");
    const broken: Spawner = async () => { throw new Error("ENOENT"); };
    const [p2] = await runAuthProbes(["claude-code"], { spawn: broken, env: {}, now: NOW });
    assert.equal(p2.verdict, "unreachable");
  });

  test("github probes via `gh auth status`; unknown provider → unavailable", async () => {
    const spawn: Spawner = async (cmd, args) => {
      assert.equal(cmd, "gh");
      assert.deepEqual(args, ["auth", "status"]);
      return { exitCode: 0, stdout: "", stderr: "Logged in" };
    };
    const [gh] = await runAuthProbes(["github"], { spawn, env: {}, now: NOW });
    assert.equal(gh.verdict, "ok");
    const [mystery] = await runAuthProbes(["totally-new-provider"], { env: {}, now: NOW });
    assert.equal(mystery.verdict, "unavailable");
    assert.match(mystery.detail, /configured only/);
  });
});

describe("runModelPings (tier 2)", () => {
  test("claude-code ping spawns non-interactively with CI guard and 'spawns process' cost", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const spawn: Spawner = async (_cmd, args, opts) => {
      seenEnv = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
      assert.deepEqual(args.slice(0, 2), ["--print", "ping"]);
      return { exitCode: 0, stdout: "pong", stderr: "" };
    };
    const [p] = await runModelPings({ planning: "claude-code/claude-fable-5" }, { spawn, env: {}, now: NOW });
    assert.equal(p.tier, "ping");
    assert.equal(p.verdict, "ok");
    assert.equal(p.cost, "spawns process");
    assert.equal(seenEnv?.CI, "1");
  });

  test("metered provider ping posts a 1-token request and reports token cost", async () => {
    const fetcher: Fetcher = async (url, init) => {
      assert.match(url, /openrouter\.ai\/api\/v1\/chat\/completions/);
      assert.match(init.body ?? "", /"max_tokens":1/);
      return { status: 200 };
    };
    const [p] = await runModelPings(
      { execution: "openrouter/anthropic/claude-opus-4.7" },
      { fetcher, env: { OPENROUTER_API_KEY: SECRET }, now: NOW },
    );
    assert.equal(p.verdict, "ok");
    assert.equal(p.cost, "≈1 token");
    assert.ok(!JSON.stringify(p).includes(SECRET));
  });

  test("unknown-provider bucket is skipped, not pinged", async () => {
    const [p] = await runModelPings({ planning: "mystery/model-x" }, { env: {}, now: NOW });
    assert.equal(p.verdict, "skipped");
  });
});
