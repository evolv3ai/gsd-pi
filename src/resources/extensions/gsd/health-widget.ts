// Project/App: gsd-pi
// File Purpose: Always-on ambient health signal rendered below the editor.

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { execFile } from "node:child_process";
import type { GSDState } from "./types.js";
import { runProviderChecks, runProviderChecksAsync, summariseProviderIssues } from "./doctor-providers.js";
import { runEnvironmentChecks, runEnvironmentChecksAsync } from "./doctor-environment.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { loadLedgerFromDisk, getProjectTotals } from "./metrics.js";
import { describeNextUnit, estimateTimeRemaining, updateSliceProgressCache } from "./auto-dashboard.js";
import { projectRoot } from "./commands/context.js";
import { deriveState, invalidateStateCache } from "./state.js";
import {
  buildHealthLines,
  detectHealthWidgetProjectState,
  type HealthWidgetData,
  type HealthWidgetProjectState,
} from "./health-widget-core.js";

export const HEALTH_WIDGET_ACTIVE_HINTS =
  "  /gsd auto to run  ·  /gsd status to inspect  ·  /gsd report for snapshots  ·  /gsd notifications for history  ·  /gsd help";

const LAST_COMMIT_LOOKUP_TIMEOUT_MS = 3_000;
const REFRESH_INTERVAL_MS = 60_000;
const PROJECT_STATE_CACHE_TTL_MS = REFRESH_INTERVAL_MS;

// ── Data loader ────────────────────────────────────────────────────────────────

const projectStateCache = new Map<string, { state: HealthWidgetProjectState; computedAt: number }>();

export function getCachedProjectState(basePath: string, force?: boolean): HealthWidgetProjectState {
  const now = Date.now();
  const cached = projectStateCache.get(basePath);
  if (!force && cached && now - cached.computedAt <= PROJECT_STATE_CACHE_TTL_MS) {
    return cached.state;
  }

  const state = detectHealthWidgetProjectState(basePath);
  projectStateCache.set(basePath, { state, computedAt: now });
  return state;
}

function runHealthWidgetGit(basePath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: basePath,
        timeout: LAST_COMMIT_LOOKUP_TIMEOUT_MS,
        encoding: "utf-8",
        env: GIT_NO_PROMPT_ENV,
      },
      (err, stdout) => resolve(err ? null : String(stdout).trimEnd()),
    );
    child.on("error", () => resolve(null));
  });
}

async function loadLastCommitInfoAsync(basePath: string): Promise<{ epoch: number | null; message: string | null }> {
  try {
    if ((await runHealthWidgetGit(basePath, ["rev-parse", "--git-dir"])) === null) {
      return { epoch: null, message: null };
    }

    const branch = await runHealthWidgetGit(basePath, ["branch", "--show-current"]);
    const ref = branch || "HEAD";
    const raw = await runHealthWidgetGit(basePath, ["log", "-1", "--format=%ct%x00%s", ref]);
    if (!raw) return { epoch: null, message: null };

    const separator = raw.indexOf("\0");
    const epochText = separator >= 0 ? raw.slice(0, separator) : raw;
    const epoch = parseInt(epochText.trim(), 10) || 0;
    if (epoch <= 0) return { epoch: null, message: null };

    const message = separator >= 0 ? raw.slice(separator + 1).trim() : "";
    return { epoch, message: message || null };
  } catch {
    return { epoch: null, message: null };
  }
}

function loadHealthWidgetData(
  basePath: string,
  options?: { includeChecks?: boolean; forceProjectState?: boolean },
): HealthWidgetData {
  // `includeChecks` gates the expensive subprocess-backed checks (provider +
  // environment doctor: `lsof`, `docker`, `node --version`, ...). The initial
  // synchronous render passes `false` so first paint is never blocked on them;
  // the async refresh (off the first-paint path) runs the full suite.
  const includeChecks = options?.includeChecks ?? true;
  let budgetCeiling: number | undefined;
  let budgetSpent = 0;
  let providerIssue: string | null = null;
  let environmentErrorCount = 0;
  let environmentWarningCount = 0;
  let lastCommitEpoch: number | null = null;
  let lastCommitMessage: string | null = null;

  const projectState = getCachedProjectState(basePath, options?.forceProjectState);

  try {
    const prefs = loadEffectiveGSDPreferences();
    budgetCeiling = prefs?.preferences?.budget_ceiling;

    const ledger = loadLedgerFromDisk(basePath);
    if (ledger) {
      const totals = getProjectTotals(ledger.units ?? []);
      budgetSpent = totals.cost;
    }
  } catch { /* non-fatal */ }

  if (includeChecks) {
    try {
      const providerResults = runProviderChecks();
      providerIssue = summariseProviderIssues(providerResults);
    } catch { /* non-fatal */ }

    try {
      const envResults = runEnvironmentChecks(basePath);
      for (const r of envResults) {
        if (r.status === "error") environmentErrorCount++;
        else if (r.status === "warning") environmentWarningCount++;
      }
    } catch { /* non-fatal */ }
  }

  return {
    projectState,
    budgetCeiling,
    budgetSpent,
    providerIssue,
    environmentErrorCount,
    environmentWarningCount,
    lastCommitEpoch,
    lastCommitMessage,
    lastRefreshed: Date.now(),
  };
}

// Non-blocking variant used by the widget's background refresh: the cheap fields
// come from the synchronous snapshot, then provider, environment, and last-commit
// checks are layered in off the event-loop critical path.
async function loadHealthWidgetDataAsync(basePath: string): Promise<HealthWidgetData> {
  const data = loadHealthWidgetData(basePath, { includeChecks: false });
  let providerIssue = data.providerIssue;
  let environmentErrorCount = 0;
  let environmentWarningCount = 0;

  try {
    providerIssue = summariseProviderIssues(await runProviderChecksAsync());
  } catch { /* non-fatal */ }

  try {
    const envResults = await runEnvironmentChecksAsync(basePath);
    for (const r of envResults) {
      if (r.status === "error") environmentErrorCount++;
      else if (r.status === "warning") environmentWarningCount++;
    }
  } catch { /* non-fatal */ }

  const commit = await loadLastCommitInfoAsync(basePath);

  return {
    ...data,
    providerIssue,
    environmentErrorCount,
    environmentWarningCount,
    lastCommitEpoch: commit.epoch,
    lastCommitMessage: commit.message,
    lastRefreshed: Date.now(),
  };
}

// ── Widget init ────────────────────────────────────────────────────────────────

/**
 * Initialize the always-on gsd-health widget (belowEditor).
 * Call once from the extension entry point after context is available.
 */
export function initHealthWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const basePath = projectRoot();

  // Re-init must reflect filesystem changes immediately; the TTL cache is for
  // interval refreshes, not this one-off synchronous paint.
  projectStateCache.delete(basePath);

  // String-array fallback — used in RPC mode (factory is a no-op there).
  // Skip the expensive provider/environment doctor checks here: this runs
  // synchronously on the interactive-startup path, where running them would
  // block first paint by ~0.9s (lsof/docker probes, otherwise run again
  // immediately by the factory below). The factory's async refresh fills in
  // real health once the screen is up.
  const initialData = loadHealthWidgetData(basePath, { includeChecks: false, forceProjectState: true });
  ctx.ui.setWidget("gsd-health", buildHealthLines(initialData), { placement: "belowEditor" });

  // Factory-based widget for TUI mode — replaces the string-array above
  ctx.ui.setWidget("gsd-health", (_tui, _theme) => {
    let data = initialData;
    let cachedLines: string[] | undefined;
    let refreshInFlight = false;
    let isDisposed = false;

    const refresh = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        data = await loadHealthWidgetDataAsync(basePath);
        cachedLines = undefined;
        if (!isDisposed) _tui.requestRender();
      } catch { /* non-fatal */ } finally {
        refreshInFlight = false;
      }
    };

    // Fire the first full enrichment off the first-paint path. setTimeout(0)
    // yields to the initial render + input loop, so the expensive doctor checks
    // (provider + environment) never delay the moment the user sees the UI.
    // requestRender() inside refresh repaints the widget once data is ready.
    setTimeout(() => { void refresh(); }, 0);

    const refreshTimer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    let cachedWidth: number | undefined;
    return {
      render(width: number): string[] {
        if (!cachedLines || cachedWidth !== width) {
          cachedLines = buildHealthLines(data, width);
          if (data.projectState === "active") {
            cachedLines = [...cachedLines, _theme.fg("dim", HEALTH_WIDGET_ACTIVE_HINTS)];
          }
          cachedWidth = width;
        }
        return cachedLines;
      },
      invalidate(): void { cachedLines = undefined; cachedWidth = undefined; },
      dispose(): void {
        isDisposed = true;
        clearInterval(refreshTimer);
      },
    };
  }, { placement: "belowEditor" });
}
