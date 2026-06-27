// Project/App: gsd-pi
// File Purpose: Tests for the GSD health widget state and footer hint rendering.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildHealthLines,
  detectHealthWidgetProjectState,
  formatRelativeTime,
  type HealthWidgetData,
} from "../health-widget-core.ts";
import { HEALTH_WIDGET_ACTIVE_HINTS, initHealthWidget } from "../health-widget.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import { GIT_NO_PROMPT_ENV } from "../git-constants.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-health-widget-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeTempRepo(prefix: string): string {
  const dir = makeTempDir(prefix);
  runGit(dir, "init");
  runGit(dir, "config", "user.email", "test@test.com");
  runGit(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "# test\n", "utf-8");
  runGit(dir, "add", "README.md");
  runGit(dir, "commit", "-m", "initial commit");
  return dir;
}

function installSlowGitLogShim(binDir: string): void {
  writeFileSync(
    join(binDir, "git"),
    [
      "#!/bin/sh",
      'if [ "$1" = "log" ]; then sleep 1; fi',
      'PATH="$GSD_REAL_PATH"',
      "export PATH",
      'exec git "$@"',
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(join(binDir, "git"), 0o755);

  writeFileSync(
    join(binDir, "git.cmd"),
    [
      "@echo off",
      'if "%1"=="log" powershell -NoProfile -Command "Start-Sleep -Seconds 1"',
      'set "PATH=%GSD_REAL_PATH%"',
      "git %*",
      "",
    ].join("\r\n"),
    "utf-8",
  );
}

type HealthWidgetFactory = (
  tui: { requestRender(): void },
  theme: { fg(style: string, text: string): string },
) => { dispose(): void };

function activeData(overrides: Partial<HealthWidgetData> = {}): HealthWidgetData {
  return {
    projectState: "active",
    budgetCeiling: undefined,
    budgetSpent: 0,
    providerIssue: null,
    environmentErrorCount: 0,
    environmentWarningCount: 0,
    lastCommitEpoch: null,
    lastCommitMessage: null,
    lastRefreshed: Date.now(),
    ...overrides,
  };
}

test("detectHealthWidgetProjectState: no .gsd returns none", (t) => {
  const dir = makeTempDir("none");
  t.after(() => { cleanup(dir); });

  assert.equal(detectHealthWidgetProjectState(dir), "none");
});

test("detectHealthWidgetProjectState: bootstrapped .gsd without milestones returns initialized", (t) => {
  const dir = makeTempDir("initialized");
  t.after(() => { cleanup(dir); });

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(detectHealthWidgetProjectState(dir), "initialized");
});

test("detectHealthWidgetProjectState: milestone without metrics returns active", (t) => {
  const dir = makeTempDir("active");
  t.after(() => { cleanup(dir); });

  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  assert.equal(detectHealthWidgetProjectState(dir), "active");
});

test("buildHealthLines: none state shows single onboarding line pointing at /gsd", (t) => {
  const lines = buildHealthLines(activeData({ projectState: "none" }));
  assert.equal(lines.length, 1, "renders exactly one line");
  // Should not show System OK / Budget / Last commit chrome when there's no project.
  assert.ok(!/System OK|Budget|Last commit/.test(lines[0]!), "no active-project chrome");
  // Should direct user to bootstrap via /gsd.
  assert.match(lines[0]!, /\/gsd/);
});

test("buildHealthLines: initialized state shows concise initialized line", (t) => {
  const lines = buildHealthLines(activeData({ projectState: "initialized" }));
  assert.equal(lines.length, 1, "renders exactly one line");
  assert.ok(!/System OK|Budget|Last commit/.test(lines[0]!), "no active-project chrome");
  assert.equal(lines[0], "  GSD  Project Initialized");
});

test("buildHealthLines: active state with ledger-driven spend shows spent summary", (t) => {
  const lines = buildHealthLines(activeData({ budgetSpent: 0.42 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /● System OK/);
  assert.match(lines[0]!, /Spent: 42\.0¢/);
});

test("health widget active hints include visualization and notifications", () => {
  assert.match(HEALTH_WIDGET_ACTIVE_HINTS, /\/gsd auto to run/);
  assert.match(HEALTH_WIDGET_ACTIVE_HINTS, /\/gsd status to inspect/);
  assert.match(HEALTH_WIDGET_ACTIVE_HINTS, /\/gsd report for snapshots/);
  assert.match(HEALTH_WIDGET_ACTIVE_HINTS, /\/gsd notifications for history/);
  assert.match(HEALTH_WIDGET_ACTIVE_HINTS, /\/gsd help/);
});

test("health widget async refresh does not block timers while git log is slow", async (t) => {
  const dir = makeTempRepo("slow-git-log");
  const binDir = makeTempDir("slow-git-log-bin");
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  installSlowGitLogShim(binDir);

  const originalCwd = process.cwd();
  const originalProcessPath = process.env.PATH;
  const originalEnvPath = GIT_NO_PROMPT_ENV.PATH;
  const originalEnvRealPath = GIT_NO_PROMPT_ENV.GSD_REAL_PATH;
  const shimmedPath = `${binDir}${delimiter}${originalProcessPath ?? ""}`;

  process.chdir(dir);
  process.env.PATH = shimmedPath;
  GIT_NO_PROMPT_ENV.PATH = shimmedPath;
  GIT_NO_PROMPT_ENV.GSD_REAL_PATH = originalProcessPath ?? "";

  let factory: HealthWidgetFactory | null = null;
  let resolveRefresh: (() => void) | undefined;
  const refreshed = new Promise<void>((resolve) => { resolveRefresh = resolve; });
  const gaps: number[] = [];
  let lastTick = performance.now();
  let heartbeat: NodeJS.Timeout | undefined;
  let refreshTimeout: NodeJS.Timeout | undefined;
  let widget: { dispose(): void } | undefined;

  t.after(() => {
    if (widget) widget.dispose();
    if (heartbeat) clearInterval(heartbeat);
    if (refreshTimeout) clearTimeout(refreshTimeout);
    process.chdir(originalCwd);
    if (originalProcessPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalProcessPath;
    if (originalEnvPath === undefined) delete GIT_NO_PROMPT_ENV.PATH;
    else GIT_NO_PROMPT_ENV.PATH = originalEnvPath;
    if (originalEnvRealPath === undefined) delete GIT_NO_PROMPT_ENV.GSD_REAL_PATH;
    else GIT_NO_PROMPT_ENV.GSD_REAL_PATH = originalEnvRealPath;
    cleanup(binDir);
    cleanup(dir);
  });

  initHealthWidget({
    hasUI: true,
    ui: {
      setWidget: (_key: string, value: unknown) => {
        if (typeof value === "function") factory = value as HealthWidgetFactory;
      },
    },
  } as any);

  assert.ok(factory, "health widget factory is registered");

  heartbeat = setInterval(() => {
    const now = performance.now();
    gaps.push(now - lastTick);
    lastTick = now;
  }, 25);

  // assert.ok above guards at runtime; double-cast is needed because TypeScript
  // cannot track the factory assignment through the `as any` closure call.
  widget = (factory as unknown as HealthWidgetFactory)(
    { requestRender: () => { resolveRefresh?.(); } },
    { fg: (_style: string, text: string) => text },
  );

  await Promise.race([
    refreshed,
    new Promise<never>((_, reject) => {
      refreshTimeout = setTimeout(() => reject(new Error("health widget refresh did not complete")), 4_000);
    }),
  ]);
  if (refreshTimeout) clearTimeout(refreshTimeout);

  assert.ok(gaps.length > 0, "heartbeat ran while refresh was in flight");
  const maxGap = Math.max(...gaps);
  assert.ok(maxGap < 750, `slow git log must not starve timers; max gap was ${Math.round(maxGap)}ms`);
});

test("initHealthWidget: synchronous first-paint render never contains last-commit info (regression #964)", (t) => {
  // Before the fix, loadHealthWidgetData with includeChecks:true called
  // loadLastCommitInfo — synchronous native-git-bridge ops (nativeIsRepo,
  // nativeGetCurrentBranch, nativeLastCommitEpoch, nativeCommitSubject) — which
  // froze the TUI on slow repos. The fix removes that synchronous git path
  // entirely: lastCommitEpoch/lastCommitMessage are now always null from the
  // synchronous loader; only the async refresh (loadLastCommitInfoAsync) fills
  // them in. This test guards that contract by verifying that the initial
  // string-array setWidget call never contains "Last commit:" even on a real
  // git repo where native git queries would succeed.
  const dir = makeTempRepo("sync-last-commit-regression");
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(dir);

  let widget: { dispose(): void } | undefined;
  t.after(() => {
    if (widget) widget.dispose();
    process.chdir(originalCwd);
    cleanup(dir);
  });

  const initialRenders: string[][] = [];

  initHealthWidget({
    hasUI: true,
    ui: {
      setWidget: (_key: string, value: unknown) => {
        if (Array.isArray(value)) {
          initialRenders.push(value as string[]);
        } else if (typeof value === "function") {
          // Instantiate the factory to satisfy dispose(), but do not await the
          // async refresh — we are only inspecting the synchronous first-paint.
          widget = (value as unknown as HealthWidgetFactory)(
            { requestRender: () => {} },
            { fg: (_style: string, text: string) => text },
          );
        }
      },
    },
  } as any);

  assert.ok(initialRenders.length > 0, "at least one synchronous setWidget call");

  const combined = initialRenders.flat().join("\n");
  assert.ok(
    !combined.includes("Last commit:"),
    "synchronous first-paint render must not contain 'Last commit:' — sync git path removed (regression #964)",
  );
});

test("buildHealthLines: active state with budget ceiling shows percent summary", (t) => {
  const lines = buildHealthLines(activeData({ budgetSpent: 2.5, budgetCeiling: 10 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Budget: \$2\.50\/\$10\.00 \(25%\)/);
});

test("buildHealthLines: active state with issues reports issue summary", (t) => {
  const lines = buildHealthLines(activeData({
    providerIssue: "✗ OpenAI key missing",
    environmentErrorCount: 1,
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /✗ 2 issues/);
  assert.match(lines[0]!, /✗ OpenAI key missing/);
  assert.match(lines[0]!, /Env: 1 error/);
});

// ── Last commit display ──────────────────────────────────────────────────

test("buildHealthLines: shows last commit with relative time and message", (t) => {
  const epoch = Math.floor(Date.now() / 1000) - 300; // 5 minutes ago
  const lines = buildHealthLines(activeData({
    lastCommitEpoch: epoch,
    lastCommitMessage: "feat(widget): add health display",
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Last commit: 5m ago/);
  assert.match(lines[0]!, /feat\(widget\): add health display/);
});

test("buildHealthLines: truncates long commit messages with ellipsis", (t) => {
  const epoch = Math.floor(Date.now() / 1000) - 60;
  const longMsg = "a".repeat(200); // far longer than any reasonable widget cap
  const lines = buildHealthLines(activeData({
    lastCommitEpoch: epoch,
    lastCommitMessage: longMsg,
  }));
  assert.equal(lines.length, 1);
  // Behavioural contract: rendered output is shorter than the input message
  // and ends the message portion with the ellipsis character.
  const aRun = lines[0]!.match(/a+…/);
  assert.ok(aRun, "rendered output contains a run of a-chars terminated by an ellipsis");
  assert.ok(aRun![0].length - 1 < longMsg.length, "truncated message is shorter than input");
  assert.ok(!lines[0]!.includes("a".repeat(longMsg.length)), "untruncated message must not appear in output");
});

test("buildHealthLines: no last commit section when epoch is null", (t) => {
  const lines = buildHealthLines(activeData({ lastCommitEpoch: null }));
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("Last commit"), "no last commit when null");
});

test("buildHealthLines: last commit without message shows only time", (t) => {
  const epoch = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
  const lines = buildHealthLines(activeData({
    lastCommitEpoch: epoch,
    lastCommitMessage: null,
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Last commit: 1h ago/);
  assert.ok(!lines[0]!.includes(" — "), "no dash separator when no message");
});

// ── formatRelativeTime ───────────────────────────────────────────────────

test("formatRelativeTime: just now for <60s", () => {
  const epoch = Math.floor(Date.now() / 1000) - 30;
  assert.equal(formatRelativeTime(epoch), "just now");
});

test("formatRelativeTime: minutes", () => {
  const epoch = Math.floor(Date.now() / 1000) - 300;
  assert.equal(formatRelativeTime(epoch), "5m ago");
});

test("formatRelativeTime: hours", () => {
  const epoch = Math.floor(Date.now() / 1000) - 7200;
  assert.equal(formatRelativeTime(epoch), "2h ago");
});

test("formatRelativeTime: days", () => {
  const epoch = Math.floor(Date.now() / 1000) - 172800;
  assert.equal(formatRelativeTime(epoch), "2d ago");
});

test("detectHealthWidgetProjectState: metrics file alone does not imply project", (t) => {
  const dir = makeTempDir("metrics-only");
  t.after(() => { cleanup(dir); });

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "metrics.json"),
    JSON.stringify({ version: 1, projectStartedAt: Date.now(), units: [] }),
    "utf-8",
  );
  assert.equal(detectHealthWidgetProjectState(dir), "initialized");
});

test("session_start bootstraps the health widget alongside notifications", async (t) => {
  const dir = makeTempDir("bootstrap");
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    cleanup(dir);
  });

  const widgets: string[] = [];
  const statuses: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as any;

  registerHooks(pi, []);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler is registered");

  await sessionStart!({}, {
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: (key: string) => {
        statuses.push(key);
      },
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: (key: string) => {
        widgets.push(key);
      },
    },
    sessionManager: {
      getSessionId: () => null,
    },
    model: null,
    setCompactionThresholdOverride: () => {},
  } as any);

  assert.ok(widgets.includes("gsd-health"), "health widget is bootstrapped");
  assert.ok(
    statuses.some((k) => k.includes("notifications")),
    "notification status chip is registered",
  );
});
