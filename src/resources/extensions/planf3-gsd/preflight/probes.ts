import { realSpawner } from "../gsd/real-spawner.js";
import type { Spawner } from "../gsd/headless-runner.js";
import type { ProbeOutcome } from "./types.js";

export interface FetchResponse { status: number; }
export type Fetcher = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

export interface ProbeDeps {
  fetcher?: Fetcher;
  spawn?: Spawner;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  timeoutMs?: number;
}

interface ResolvedDeps {
  fetcher: Fetcher;
  spawn: Spawner;
  env: NodeJS.ProcessEnv;
  now: () => string;
  timeoutMs: number;
}

function resolve(deps: ProbeDeps = {}): ResolvedDeps {
  return {
    fetcher: deps.fetcher ?? (async (url, init) => {
      const res = await fetch(url, init);
      return { status: res.status };
    }),
    spawn: deps.spawn ?? realSpawner,
    env: deps.env ?? process.env,
    now: deps.now ?? (() => new Date().toISOString()),
    timeoutMs: deps.timeoutMs ?? 5000,
  };
}

function outcome(target: string, tier: ProbeOutcome["tier"], verdict: ProbeOutcome["verdict"], detail: string, d: ResolvedDeps, cost?: string): ProbeOutcome {
  return { target, tier, verdict, detail, checkedAt: d.now(), ...(cost !== undefined ? { cost } : {}) };
}

async function httpAuthProbe(target: string, url: string, headers: Record<string, string>, d: ResolvedDeps): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), d.timeoutMs);
  try {
    const res = await d.fetcher(url, { headers, signal: controller.signal });
    // Details carry fixed text + status codes ONLY — never header/key material.
    if (res.status >= 200 && res.status < 300) return outcome(target, "auth", "ok", `HTTP ${res.status}`, d);
    if (res.status === 401 || res.status === 403) return outcome(target, "auth", "failed", `auth rejected (HTTP ${res.status})`, d);
    return outcome(target, "auth", "failed", `unexpected HTTP ${res.status}`, d);
  } catch {
    return outcome(target, "auth", "unreachable", "network error or timeout", d);
  } finally {
    clearTimeout(timer);
  }
}

async function spawnProbe(target: string, cmd: string, args: string[], judge: (r: { exitCode: number; stdout: string; stderr: string }) => { ok: boolean; detail: string }, d: ResolvedDeps): Promise<ProbeOutcome> {
  try {
    const result = await d.spawn(cmd, args, { cwd: process.cwd(), timeoutMs: d.timeoutMs });
    const { ok, detail } = judge(result);
    return outcome(target, "auth", ok ? "ok" : "failed", detail, d);
  } catch {
    return outcome(target, "auth", "unreachable", `could not run ${cmd}`, d);
  }
}

/** Reference implementation: src/claude-cli-check.ts:133-175 (isClaudeCliReady) —
 *  spawned, not imported: extensions do not import from host src/. */
function judgeClaudeAuth(r: { exitCode: number; stdout: string; stderr: string }): { ok: boolean; detail: string } {
  try {
    const parsed = JSON.parse(r.stdout) as { loggedIn?: boolean };
    if (typeof parsed.loggedIn === "boolean") {
      return parsed.loggedIn ? { ok: true, detail: "claude CLI logged in" } : { ok: false, detail: "claude CLI not logged in" };
    }
  } catch { /* fall through to plain-text heuristic */ }
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
  if (r.exitCode === 0 && !text.includes("not logged in")) return { ok: true, detail: "claude CLI auth status ok" };
  return { ok: false, detail: "claude CLI auth status not ok" };
}

type AuthProbeFn = (d: ResolvedDeps) => Promise<ProbeOutcome>;

const AUTH_PROBES: Record<string, AuthProbeFn> = {
  openrouter: (d) => {
    const key = d.env.OPENROUTER_API_KEY;
    if (!key) return Promise.resolve(outcome("openrouter", "auth", "failed", "OPENROUTER_API_KEY not set", d));
    return httpAuthProbe("openrouter", "https://openrouter.ai/api/v1/auth/key", { Authorization: `Bearer ${key}` }, d);
  },
  anthropic: (d) => {
    const key = d.env.ANTHROPIC_API_KEY;
    if (!key) return Promise.resolve(outcome("anthropic", "auth", "failed", "ANTHROPIC_API_KEY not set", d));
    return httpAuthProbe("anthropic", "https://api.anthropic.com/v1/models", { "x-api-key": key, "anthropic-version": "2023-06-01" }, d);
  },
  "claude-code": (d) => spawnProbe("claude-code", "claude", ["auth", "status", "--json"], judgeClaudeAuth, d),
  github: (d) => spawnProbe("github", "gh", ["auth", "status"], (r) => (r.exitCode === 0 ? { ok: true, detail: "gh auth status ok" } : { ok: false, detail: `gh auth status exit ${r.exitCode}` }), d),
};

/**
 * Tier-1 auth probes — projection-scoped: callers pass exactly the providers the
 * post-overlay projection uses; this function never enumerates local credentials
 * beyond that list (spec §8).
 */
export async function runAuthProbes(providers: string[], deps: ProbeDeps = {}): Promise<ProbeOutcome[]> {
  const d = resolve(deps);
  return Promise.all(
    [...new Set(providers)].map((provider) => {
      const probe = AUTH_PROBES[provider];
      if (!probe) return Promise.resolve(outcome(provider, "auth", "unavailable", "no auth probe registered — configured only", d));
      return probe(d);
    }),
  );
}

function providerOf(modelId: string): string {
  return modelId.split("/")[0] ?? modelId;
}

/**
 * Tier-2 pings (opt-in --ping): one minimal real call per bucket. Prompt-proofed:
 * hard timeout, non-interactive env (CI=1, NO_COLOR=1), no stdin — an
 * unauthenticated CLI trying to go interactive must fail fast, not hang.
 */
export async function runModelPings(buckets: Record<string, string>, deps: ProbeDeps = {}): Promise<ProbeOutcome[]> {
  const d = resolve(deps);
  return Promise.all(
    Object.entries(buckets).map(async ([bucket, modelId]) => {
      const provider = providerOf(modelId);
      const target = `ping:${bucket}`;
      if (provider === "claude-code") {
        try {
          const result = await d.spawn("claude", ["--print", "ping", "--model", modelId.split("/").slice(1).join("/")], {
            cwd: process.cwd(),
            timeoutMs: d.timeoutMs,
            env: { ...d.env, CI: "1", NO_COLOR: "1" },
            stdin: "ignore",
          });
          return outcome(target, "ping", result.exitCode === 0 ? "ok" : "failed", `claude --print exit ${result.exitCode}`, d, "spawns process");
        } catch {
          return outcome(target, "ping", "unreachable", "could not run claude CLI", d, "spawns process");
        }
      }
      if (provider === "openrouter" || provider === "anthropic") {
        const key = provider === "openrouter" ? d.env.OPENROUTER_API_KEY : d.env.ANTHROPIC_API_KEY;
        if (!key) return outcome(target, "ping", "failed", `${provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"} not set`, d, "≈1 token");
        const url = provider === "openrouter"
          ? "https://openrouter.ai/api/v1/chat/completions"
          : "https://api.anthropic.com/v1/messages";
        const headers = provider === "openrouter"
          ? { Authorization: `Bearer ${key}`, "content-type": "application/json" }
          : { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
        const model = modelId.split("/").slice(1).join("/");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), d.timeoutMs);
        try {
          const res = await d.fetcher(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
            signal: controller.signal,
          });
          return outcome(target, "ping", res.status >= 200 && res.status < 300 ? "ok" : "failed", `HTTP ${res.status}`, d, "≈1 token");
        } catch {
          return outcome(target, "ping", "unreachable", "network error or timeout", d, "≈1 token");
        } finally {
          clearTimeout(timer);
        }
      }
      return outcome(target, "ping", "skipped", `no ping recipe for provider "${provider}"`, d);
    }),
  );
}
