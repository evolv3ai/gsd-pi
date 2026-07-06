import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GSD_BROWSER_MCP_SERVER_NAME = "gsd-browser";

export interface GsdBrowserMcpLaunchConfig {
  serverName: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  projectRoot: string;
  sessionName: string;
}

export interface GsdBrowserMcpLaunchOptions {
  sessionName?: string;
  sessionSuffix?: string;
}

function parseJsonEnv<T>(env: NodeJS.ProcessEnv, name: string): T | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid JSON in ${name}`);
  }
}

function sanitizeSessionSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function compareSemverLocal(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftValue = left[index] || 0;
    const rightValue = right[index] || 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function parseGsdBrowserVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

function splitCommandLine(commandLine: string): string[] {
  const parts = commandLine.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)/g) ?? [];
  return parts.map((part) => {
    const quote = part[0];
    if ((quote === '"' || quote === "'") && part.endsWith(quote)) {
      return part.slice(1, -1);
    }
    return part;
  });
}

/**
 * Extra gsd-browser CLI flags to forward verbatim to the launched daemon, from
 * GSD_BROWSER_MCP_EXTRA_ARGS. Unlike GSD_BROWSER_MCP_ARGS (a full args override),
 * these are *appended* to the default `mcp`/`daemon start` invocation so callers
 * keep the managed session/identity flags. Accepts a JSON array (e.g.
 * `["--stealth"]`) or a plain, optionally-quoted command-line string
 * (e.g. `--stealth --browser-path /usr/bin/chromium`). This is the config-level
 * knob for environments where Chrome needs extra launch flags — e.g. containers
 * without unprivileged user namespaces, where `--stealth` supplies Chrome's
 * `--no-sandbox`.
 */
function resolveExtraGsdBrowserArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.GSD_BROWSER_MCP_EXTRA_ARGS?.trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    const parsed = parseJsonEnv<unknown>(env, "GSD_BROWSER_MCP_EXTRA_ARGS");
    if (!Array.isArray(parsed)) {
      throw new Error("GSD_BROWSER_MCP_EXTRA_ARGS JSON must be an array of strings");
    }
    return parsed.map(String);
  }
  return splitCommandLine(raw);
}

function buildPathGsdBrowserVersionInvocation(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "cmd", args: ["/d", "/s", "/c", "gsd-browser", "--version"] };
  }
  return { command: "gsd-browser", args: ["--version"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveExplicitGsdBrowserCliPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.GSD_BROWSER_CLI_PATH?.trim() || env.GSD_BROWSER_BIN_PATH?.trim() || undefined;
}

function resolveBundledGsdBrowserPackageVersion(): string | null {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const packageJsonPath = requireFromHere.resolve("@opengsd/gsd-browser/package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? parseGsdBrowserVersion(pkg.version) : null;
  } catch {
    return null;
  }
}

// The `gsd-browser --version` subprocess result cannot change mid-session (the
// engine-switch guard forbids restarting with a different engine), and both the
// availability probe and the launch-config resolution ask for it at session
// start — memoize so the up-to-2s spawn happens once per process.
let cachedPathProbeVersion: string | null | undefined;

function resolvePathGsdBrowserVersion(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.GSD_BROWSER_PATH_VERSION?.trim();
  if (explicit) return parseGsdBrowserVersion(explicit);
  if (cachedPathProbeVersion !== undefined) return cachedPathProbeVersion;

  try {
    const invocation = buildPathGsdBrowserVersionInvocation(process.platform);
    cachedPathProbeVersion = parseGsdBrowserVersion(execFileSync(invocation.command, invocation.args, {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }));
  } catch {
    cachedPathProbeVersion = null;
  }
  return cachedPathProbeVersion;
}

function resolveGsdBrowserNativeBinaryPath(launcherPath: string, platform: NodeJS.Platform = process.platform): string {
  const binDir = resolve(launcherPath, "..");
  const nativeName = platform === "win32" ? "gsd-browser.exe" : "gsd-browser-bin";
  return resolve(binDir, nativeName);
}

function isNodeShLauncher(launcherPath: string): boolean {
  try {
    return readFileSync(launcherPath, "utf-8").startsWith("#!");
  } catch {
    // Non-text launchers (native binaries) are runnable without a sibling shim.
    return false;
  }
}

/**
 * The npm package ships a node launcher that execs `gsd-browser-bin` beside it.
 * pnpm can skip postinstall, leaving only the launcher — which exits immediately
 * and surfaces as MCP "Connection closed". Treat that layout as unavailable.
 */
function isGsdBrowserPackageLauncherRunnable(launcherPath: string): boolean {
  if (!existsSync(launcherPath)) return false;
  const nativePath = resolveGsdBrowserNativeBinaryPath(launcherPath);
  if (existsSync(nativePath)) return true;
  return !isNodeShLauncher(launcherPath);
}

function shouldPreferPathGsdBrowser(env: NodeJS.ProcessEnv): boolean {
  const pathVersion = resolvePathGsdBrowserVersion(env);
  if (!pathVersion) return false;

  const bundledVersion = resolveBundledGsdBrowserPackageVersion();
  if (!bundledVersion || compareSemverLocal(pathVersion, bundledVersion) > 0) {
    return true;
  }

  // Same or newer bundled semver still loses when the package launcher cannot run.
  const bundledLauncher = resolveBundledGsdBrowserLauncherPath(env);
  return bundledLauncher !== null && !isGsdBrowserPackageLauncherRunnable(bundledLauncher);
}

function resolveBundledGsdBrowserLauncherPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = resolveExplicitGsdBrowserCliPath(env);
  if (explicit) return explicit;

  try {
    const requireFromHere = createRequire(import.meta.url);
    const packageJsonPath = requireFromHere.resolve("@opengsd/gsd-browser/package.json");
    const candidate = resolve(packageJsonPath, "..", "bin", "gsd-browser");
    if (existsSync(candidate)) return candidate;
  } catch {
    // Fall through to path candidates for source/dist layouts.
  }

  const candidates = [
    resolve(fileURLToPath(new URL("../../../../node_modules/@opengsd/gsd-browser/bin/gsd-browser", import.meta.url))),
    resolve(fileURLToPath(new URL("../../../../node_modules/.bin/gsd-browser", import.meta.url))),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function resolveBundledGsdBrowserCliPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const launcher = resolveBundledGsdBrowserLauncherPath(env);
  if (!launcher || !isGsdBrowserPackageLauncherRunnable(launcher)) return null;
  return launcher;
}

export type GsdBrowserCliAvailability =
  | { available: true; via: "explicit-env" | "bundled" | "path"; detail: string }
  | { available: false; detail: string };

/**
 * Cheap availability probe for the gsd-browser CLI: explicit env overrides,
 * then the bundled @opengsd/gsd-browser binary (filesystem checks only), then
 * a PATH lookup (one short subprocess, memoized). Used by Browser Automation
 * Engine resolution to decide whether the managed engine is provable before
 * preferring it over legacy Playwright. `via` names the provable source, not
 * necessarily the launch source — resolveGsdBrowserMcpLaunchConfig may still
 * prefer a newer PATH CLI over the bundled one.
 */
export function resolveGsdBrowserCliAvailability(env: NodeJS.ProcessEnv = process.env): GsdBrowserCliAvailability {
  const explicitCommand = env.GSD_BROWSER_MCP_COMMAND?.trim();
  if (explicitCommand) {
    return { available: true, via: "explicit-env", detail: `GSD_BROWSER_MCP_COMMAND=${explicitCommand}` };
  }

  const explicitCliPath = resolveExplicitGsdBrowserCliPath(env);
  if (explicitCliPath) {
    return existsSync(explicitCliPath)
      ? { available: true, via: "explicit-env", detail: `CLI at ${explicitCliPath}` }
      : { available: false, detail: `configured gsd-browser CLI path does not exist: ${explicitCliPath}` };
  }

  const bundledCliPath = resolveBundledGsdBrowserCliPath(env);
  if (bundledCliPath) {
    return { available: true, via: "bundled", detail: `bundled CLI at ${bundledCliPath}` };
  }

  const pathVersion = resolvePathGsdBrowserVersion(env);
  if (pathVersion) {
    return { available: true, via: "path", detail: `gsd-browser ${pathVersion} on PATH` };
  }

  return { available: false, detail: "no bundled or PATH gsd-browser CLI found" };
}

export function buildGsdBrowserSessionName(projectRoot: string, suffix?: string): string {
  const resolvedProjectRoot = resolve(projectRoot);
  const base = sanitizeSessionSegment(basename(resolvedProjectRoot)) || "project";
  const hash = createHash("sha1").update(resolvedProjectRoot).digest("hex").slice(0, 8);
  const cleanSuffix = suffix ? sanitizeSessionSegment(suffix) : "";
  return cleanSuffix ? `gsd-${base}-${hash}-${cleanSuffix}` : `gsd-${base}-${hash}`;
}

/**
 * Recognize an MCP server config (from .mcp.json / Claude settings) as a
 * gsd-browser server. Paired with resolveGsdBrowserMcpLaunchConfig: this module
 * writes the config shape, so it also owns recognizing it. New launch shapes
 * are taught here, in one place.
 */
export function isGsdBrowserMcpServerConfig(config: unknown): boolean {
  if (!isRecord(config)) return false;

  const command = typeof config.command === "string" ? config.command : "";
  if (command.includes("gsd-browser") || command.includes("@opengsd/gsd-browser")) {
    return true;
  }

  if (isRecord(config.env)) {
    const env = config.env;
    if (
      typeof env.GSD_BROWSER_CLI_PATH === "string"
      || typeof env.GSD_BROWSER_BIN_PATH === "string"
      || typeof env.GSD_BROWSER_MCP_COMMAND === "string"
    ) {
      return true;
    }
  }

  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [];
  return args.some((arg) => arg.includes("gsd-browser") || arg.includes("@opengsd/gsd-browser"));
}

export function resolveGsdBrowserMcpLaunchConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: GsdBrowserMcpLaunchOptions = {},
): GsdBrowserMcpLaunchConfig {
  const resolvedProjectRoot = resolve(projectRoot);
  const serverName = env.GSD_BROWSER_MCP_NAME?.trim() || GSD_BROWSER_MCP_SERVER_NAME;
  const explicitArgs = parseJsonEnv<unknown>(env, "GSD_BROWSER_MCP_ARGS");
  const explicitEnv = parseJsonEnv<Record<string, string>>(env, "GSD_BROWSER_MCP_ENV");
  const explicitCommandLine = env.GSD_BROWSER_MCP_COMMAND?.trim();
  const [explicitCommand, ...explicitCommandArgs] = explicitCommandLine ? splitCommandLine(explicitCommandLine) : [];
  const explicitCliPath = resolveExplicitGsdBrowserCliPath(env);
  const preferPathCli = !explicitCommand && !explicitCliPath && shouldPreferPathGsdBrowser(env);
  const bundledCliPath = !explicitCommand && !explicitCliPath && !preferPathCli
    ? resolveBundledGsdBrowserCliPath(env)
    : null;
  const sessionName =
    options.sessionName?.trim() || buildGsdBrowserSessionName(resolvedProjectRoot, options.sessionSuffix);
  // Stable per-project identity key (no per-session suffix) so the browser
  // profile/cookies persist across pi sessions for the same project. gsd-browser
  // rejects --identity-scope unless --identity-key is also supplied.
  const identityKey = env.GSD_BROWSER_IDENTITY_KEY?.trim() || buildGsdBrowserSessionName(resolvedProjectRoot);
  // identity-project must be a safe identifier (no path separators); full paths
  // cause daemon startup to fail with "invalid name".
  const identityProject =
    env.GSD_BROWSER_IDENTITY_PROJECT?.trim() || buildGsdBrowserSessionName(resolvedProjectRoot);
  const command =
    explicitCommand
    || explicitCliPath
    || (preferPathCli ? "gsd-browser" : undefined)
    || (bundledCliPath ? process.execPath : undefined)
    || "gsd-browser";
  // Appended after the managed session/identity flags so they survive the
  // daemon-start transformation (which forwards everything after `mcp`), letting
  // callers add extra Chrome/gsd-browser launch flags via one config knob.
  const extraArgs = resolveExtraGsdBrowserArgs(env);
  const args = Array.isArray(explicitArgs) && explicitArgs.length > 0
    ? explicitArgs.map(String)
    : [
        ...explicitCommandArgs,
        ...(bundledCliPath ? [bundledCliPath] : []),
        "mcp",
        "--session",
        sessionName,
        "--identity-scope",
        "project",
        "--identity-key",
        identityKey,
        "--identity-project",
        identityProject,
        ...extraArgs,
      ];
  const cwd = env.GSD_BROWSER_MCP_CWD?.trim() || resolvedProjectRoot;

  return {
    serverName,
    command,
    args,
    cwd,
    ...(explicitEnv ? { env: explicitEnv } : {}),
    projectRoot: resolvedProjectRoot,
    sessionName,
  };
}

/**
 * CLI invocation that runs a `daemon <action>` command against the gsd-browser
 * session daemon with the same session and identity flags as
 * {@link resolveGsdBrowserMcpLaunchConfig}, so start (warm-up) and stop
 * (teardown) address the exact same managed daemon.
 */
function resolveGsdBrowserDaemonInvocation(
  action: "start" | "stop",
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  options: GsdBrowserMcpLaunchOptions,
): Pick<GsdBrowserMcpLaunchConfig, "command" | "args" | "cwd" | "env"> {
  const launch = resolveGsdBrowserMcpLaunchConfig(projectRoot, env, options);
  const mcpIndex = launch.args.indexOf("mcp");
  if (mcpIndex < 0) {
    throw new Error("gsd-browser launch config is missing mcp subcommand");
  }

  const prefix = launch.args.slice(0, mcpIndex);
  const sessionFlags = launch.args.slice(mcpIndex + 1);
  return {
    command: launch.command,
    args: [...prefix, "daemon", action, ...sessionFlags],
    cwd: launch.cwd,
    ...(launch.env ? { env: launch.env } : {}),
  };
}

/**
 * CLI invocation that starts the gsd-browser session daemon with the same
 * session and identity flags as {@link resolveGsdBrowserMcpLaunchConfig}, so
 * browser UAT can warm Chrome/CDP before the first MCP navigation.
 */
export function resolveGsdBrowserDaemonStartInvocation(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: GsdBrowserMcpLaunchOptions = {},
): Pick<GsdBrowserMcpLaunchConfig, "command" | "args" | "cwd" | "env"> {
  return resolveGsdBrowserDaemonInvocation("start", projectRoot, env, options);
}

/**
 * CLI invocation that stops the gsd-browser session daemon warmed for browser
 * UAT, so the Chrome process is torn down instead of lingering after the
 * triggering task/session ends.
 */
export function resolveGsdBrowserDaemonStopInvocation(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: GsdBrowserMcpLaunchOptions = {},
): Pick<GsdBrowserMcpLaunchConfig, "command" | "args" | "cwd" | "env"> {
  return resolveGsdBrowserDaemonInvocation("stop", projectRoot, env, options);
}
