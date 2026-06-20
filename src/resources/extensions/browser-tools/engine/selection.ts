/**
 * Browser Automation Engine resolution (ADR-037).
 *
 * The engine choice behind the canonical `browser_*` tools is a runtime
 * decision with a recorded reason, not a static default:
 *   - An explicit `GSD_BROWSER_ENGINE` override is honored verbatim.
 *   - Otherwise, browser-facing projects prefer the managed gsd-browser engine
 *     when the availability probe can prove a CLI exists, and fall back to
 *     legacy Playwright with the failure reason recorded.
 *   - Non-browser-facing projects keep legacy Playwright (browser tools are
 *     incidental there; the managed daemon is not worth its startup risk).
 *
 * This module owns the committed resolution, not just the prediction: when
 * registration verifies a probe-resolved managed engine (daemon connect) and
 * falls back, the outcome is committed here so every ambient reader — UAT
 * guidance, re-warm-up, later sessions in the same process — sees the engine
 * the session actually registered.
 */
import path from "node:path";

import { resolveGsdBrowserCliAvailability } from "../../shared/gsd-browser-cli.js";
import { detectWebApp } from "../web-app-detect.js";

export type BrowserEngineMode = "gsd-browser" | "legacy" | "off";

export interface BrowserEngineResolution {
  engine: BrowserEngineMode;
  /** "env" = explicit GSD_BROWSER_ENGINE override; "probe" = default path decided by availability. */
  source: "env" | "probe";
  reason: string;
}

const committedResolutionByProjectRoot = new Map<string, BrowserEngineResolution>();

function parseExplicitEngineMode(raw: string): BrowserEngineMode {
  const normalized = raw.toLowerCase();
  if (normalized === "gsd-browser" || normalized === "gsd_browser" || normalized === "gsdbrowser") {
    return "gsd-browser";
  }
  if (normalized === "legacy" || normalized === "playwright") return "legacy";
  if (normalized === "off" || normalized === "none" || normalized === "disabled" || normalized === "0" || normalized === "false") {
    return "off";
  }

  throw new Error(`Invalid GSD_BROWSER_ENGINE="${raw}". Expected "gsd-browser", "legacy", or "off".`);
}

/** Pure resolution from explicit inputs. Never cached; probes on every call. */
export function resolveBrowserEngineResolution(
  env: NodeJS.ProcessEnv,
  projectRoot?: string,
): BrowserEngineResolution {
  const raw = env.GSD_BROWSER_ENGINE?.trim();
  if (raw) {
    return { engine: parseExplicitEngineMode(raw), source: "env", reason: `GSD_BROWSER_ENGINE=${raw}` };
  }

  if (!projectRoot) {
    return { engine: "legacy", source: "probe", reason: "no project root to probe; using legacy Playwright" };
  }

  if (!detectWebApp(projectRoot)) {
    return {
      engine: "legacy",
      source: "probe",
      reason: "project is not browser-facing; using legacy Playwright",
    };
  }

  const availability = resolveGsdBrowserCliAvailability(env);
  return availability.available
    ? {
        engine: "gsd-browser",
        source: "probe",
        reason: `web app detected and managed gsd-browser engine available (${availability.detail})`,
      }
    : {
        engine: "legacy",
        source: "probe",
        reason: `web app detected but gsd-browser unavailable (${availability.detail}); falling back to legacy Playwright`,
      };
}

/**
 * Session-facing resolution: the committed record for this project root, or
 * the ambient probe result, cached as the initial commitment (the probe
 * touches the filesystem and at worst one short subprocess).
 */
export function resolveAmbientBrowserEngineResolution(projectRoot: string): BrowserEngineResolution {
  const key = path.resolve(projectRoot);
  const committed = committedResolutionByProjectRoot.get(key);
  if (committed) return committed;

  const resolution = resolveBrowserEngineResolution(process.env, projectRoot);
  committedResolutionByProjectRoot.set(key, resolution);
  return resolution;
}

/**
 * Record a verified outcome for this project root — e.g. the probe predicted
 * gsd-browser but the daemon-connect gate fell back to legacy Playwright.
 */
export function commitBrowserEngineResolution(projectRoot: string, resolution: BrowserEngineResolution): void {
  committedResolutionByProjectRoot.set(path.resolve(projectRoot), resolution);
}
