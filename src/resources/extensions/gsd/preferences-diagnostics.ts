import type { PreferenceDiagnostic } from "./preferences-types.js";
import {
  loadEffectiveGSDPreferences,
  loadGlobalGSDPreferences,
  loadProjectGSDPreferences,
} from "./preferences.js";
import { crossAxisPreferenceWarnings } from "./preferences-validation.js";

interface PreferenceNotificationContext {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
  };
}

interface PreferenceDiagnosticNotificationOptions {
  surface?: string;
}

const notifiedPreferenceDiagnostics = new Set<string>();

export function collectPreferenceDiagnostics(basePath?: string): PreferenceDiagnostic[] {
  const diagnostics = [
    ...(loadGlobalGSDPreferences()?.diagnostics ?? []),
    ...(loadProjectGSDPreferences(basePath)?.diagnostics ?? []),
  ];

  const seen = new Set<string>();
  const unique: PreferenceDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const signature = preferenceDiagnosticSignature(diagnostic);
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(diagnostic);
  }

  const effective = loadEffectiveGSDPreferences(basePath);
  if (effective) {
    const existingMessages = new Set(unique.map((diagnostic) => diagnostic.message));
    for (const message of crossAxisPreferenceWarnings(effective.preferences)) {
      if (existingMessages.has(message)) continue;
      const diagnostic: PreferenceDiagnostic = {
        path: effective.path,
        scope: effective.scope,
        severity: "warning",
        kind: "validation",
        message,
        sanitized: true,
      };
      const signature = preferenceDiagnosticSignature(diagnostic);
      if (seen.has(signature)) continue;
      seen.add(signature);
      existingMessages.add(message);
      unique.push(diagnostic);
    }
  }

  return unique;
}

export function formatPreferenceDiagnostic(diagnostic: PreferenceDiagnostic): string {
  const scope = diagnostic.scope === "global" ? "global" : "project";
  const level = diagnostic.severity === "error" ? "error" : "warning";
  const heading = diagnostic.kind === "parse"
    ? `GSD ${scope} preferences ${level}: ${diagnostic.path} could not be parsed.`
    : `GSD ${scope} preferences ${level}: ${diagnostic.path} contains invalid settings.`;
  const detail = formatPreferenceDiagnosticDetail(diagnostic);
  const impact = diagnostic.ignored
    ? "Preferences from this file were ignored; auto-mode may be using defaults."
    : "Invalid settings were ignored or sanitized; auto-mode may be using defaults for them.";
  return `${heading}\n${detail}\n${impact}\nRun /gsd doctor for details.`;
}

export function formatPreferenceDiagnosticDetail(diagnostic: PreferenceDiagnostic): string {
  if (diagnostic.line !== undefined && diagnostic.column !== undefined) {
    return `YAML error at line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`;
  }
  return diagnostic.message;
}

export function notifyPreferenceDiagnostics(
  ctx: PreferenceNotificationContext,
  basePath?: string,
  options?: PreferenceDiagnosticNotificationOptions,
): number {
  let notified = 0;
  for (const diagnostic of collectPreferenceDiagnostics(basePath)) {
    const signature = preferenceDiagnosticNotificationSignature(diagnostic, options?.surface);
    if (notifiedPreferenceDiagnostics.has(signature)) continue;
    notifiedPreferenceDiagnostics.add(signature);
    ctx.ui.notify(
      formatPreferenceDiagnostic(diagnostic),
      diagnostic.severity === "error" ? "error" : "warning",
    );
    notified++;
  }
  return notified;
}

export function _resetPreferenceDiagnosticNotificationsForTests(): void {
  notifiedPreferenceDiagnostics.clear();
}

function preferenceDiagnosticSignature(diagnostic: PreferenceDiagnostic): string {
  return [
    diagnostic.path,
    diagnostic.scope,
    diagnostic.severity,
    diagnostic.kind,
    diagnostic.message,
    diagnostic.line ?? "",
    diagnostic.column ?? "",
    diagnostic.ignored === true ? "ignored" : "",
    diagnostic.sanitized === true ? "sanitized" : "",
  ].join("\u0000");
}

function preferenceDiagnosticNotificationSignature(
  diagnostic: PreferenceDiagnostic,
  surface = "default",
): string {
  return `${surface}\u0000${preferenceDiagnosticSignature(diagnostic)}`;
}
