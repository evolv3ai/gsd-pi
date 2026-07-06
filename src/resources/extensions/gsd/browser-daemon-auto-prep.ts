import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  resolveAmbientBrowserEngineResolution,
  resolveBrowserEngineResolution,
  type BrowserEngineMode,
} from "../browser-tools/engine/selection.js";
import {
  resolveGsdBrowserCliAvailability,
  resolveGsdBrowserDaemonStartInvocation,
  resolveGsdBrowserDaemonStopInvocation,
} from "../shared/gsd-browser-cli.js";
import { uatTypeIncludesBrowser, type UatType } from "./uat-policy.js";

const DEFAULT_DAEMON_START_TIMEOUT_MS = 30_000;
const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 15_000;

/**
 * Project roots whose gsd-browser daemon this process warmed via
 * {@link prepareBrowserDaemonForUat}. Teardown only stops daemons we actually
 * started, so non-browser auto-mode sessions never spawn a stray `daemon stop`.
 */
const warmedDaemonProjectRoots = new Set<string>();

function isEnvDisabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function isWarmUpDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GSD_BROWSER_WARMUP?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

export interface BrowserDaemonWarmContext {
  uatType: UatType;
  sessionProvider?: string;
  sessionAuthMode?: "apiKey" | "oauth" | "externalCli" | "none";
  sessionBaseUrl?: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}

/** Active engine for warm-up: explicit env override, else session-committed ambient resolution. */
function resolveActiveBrowserEngine(projectRoot: string, env: NodeJS.ProcessEnv): BrowserEngineMode {
  if (env.GSD_BROWSER_ENGINE?.trim()) {
    return resolveBrowserEngineResolution(env, projectRoot).engine;
  }
  return resolveAmbientBrowserEngineResolution(projectRoot).engine;
}

export function shouldWarmBrowserDaemonForUat(ctx: BrowserDaemonWarmContext): boolean {
  if (!uatTypeIncludesBrowser(ctx.uatType)) return false;

  const env = ctx.env ?? process.env;
  if (isWarmUpDisabled(env)) return false;
  if (isEnvDisabled(env.GSD_BROWSER_MCP_ENABLED)) return false;

  const availability = resolveGsdBrowserCliAvailability(env);
  if (!availability.available) return false;

  const projectRoot = resolve(ctx.projectRoot);
  return resolveActiveBrowserEngine(projectRoot, env) === "gsd-browser";
}

export function ensureBrowserDaemonStarted(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { ok: true } | { ok: false; error: string } {
  const env = options.env ?? process.env;
  const availability = resolveGsdBrowserCliAvailability(env);
  if (!availability.available) {
    return { ok: false, error: availability.detail };
  }

  let invocation: ReturnType<typeof resolveGsdBrowserDaemonStartInvocation>;
  try {
    invocation = resolveGsdBrowserDaemonStartInvocation(projectRoot, env);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    execFileSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...env, ...(invocation.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? DEFAULT_DAEMON_START_TIMEOUT_MS,
      encoding: "utf-8",
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Best-effort pre-warm of the gsd-browser session daemon before browser-backed
 * run-uat dispatch. Returns an actionable stop reason when warm-up is required
 * but fails; returns null when warm-up is skipped or succeeds.
 */
export function prepareBrowserDaemonForUat(ctx: BrowserDaemonWarmContext): string | null {
  if (!shouldWarmBrowserDaemonForUat(ctx)) return null;

  const result = ensureBrowserDaemonStarted(ctx.projectRoot, { env: ctx.env });
  if (result.ok) {
    warmedDaemonProjectRoots.add(resolve(ctx.projectRoot));
    return null;
  }

  return `Cannot dispatch browser-backed run-uat: gsd-browser daemon failed to start (${result.error}). Ensure Chrome/Chromium is installed, run \`gsd-browser daemon health\` with the project session flags from .mcp.json, or set GSD_BROWSER_PATH to a Chromium binary.`;
}

/**
 * Best-effort stop of a gsd-browser session daemon warmed for browser UAT.
 * Mirrors {@link ensureBrowserDaemonStarted}; returns the failure detail rather
 * than throwing so teardown can stay non-fatal.
 */
export function stopBrowserDaemon(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { ok: true } | { ok: false; error: string } {
  const env = options.env ?? process.env;
  const availability = resolveGsdBrowserCliAvailability(env);
  if (!availability.available) {
    return { ok: false, error: availability.detail };
  }

  let invocation: ReturnType<typeof resolveGsdBrowserDaemonStopInvocation>;
  try {
    invocation = resolveGsdBrowserDaemonStopInvocation(projectRoot, env);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    execFileSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...env, ...(invocation.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? DEFAULT_DAEMON_STOP_TIMEOUT_MS,
      encoding: "utf-8",
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tear down every gsd-browser daemon this process warmed for browser UAT,
 * clearing the tracked set. Called on auto-mode loop exit so the Chrome process
 * does not survive session/task completion (mirrors the warm-up preflight).
 * Best-effort: returns the project roots whose stop failed for logging.
 */
export function teardownWarmedBrowserDaemons(
  options: { env?: NodeJS.ProcessEnv } = {},
): { projectRoot: string; error: string }[] {
  if (warmedDaemonProjectRoots.size === 0) return [];

  const failures: { projectRoot: string; error: string }[] = [];
  for (const projectRoot of warmedDaemonProjectRoots) {
    const result = stopBrowserDaemon(projectRoot, { env: options.env });
    if (!result.ok) {
      failures.push({ projectRoot, error: result.error });
    }
  }
  warmedDaemonProjectRoots.clear();
  return failures;
}
