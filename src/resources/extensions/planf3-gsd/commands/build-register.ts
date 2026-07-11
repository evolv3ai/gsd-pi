import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runBuild, type PrefsSummary, type BuildResult } from "./build.js";
import { friendlyError } from "./error-message.js";
import { emit } from "../gsd/notify.js";

export function formatPrefsLine(prefs: PrefsSummary): string {
  if (prefs.warning) return `prefs=skipped (${prefs.warning})`;
  if (!prefs.applied) return "prefs=no changes";
  const shown = prefs.commands.slice(0, 5).join(", ");
  const extra = prefs.commands.length > 5 ? ` +${prefs.commands.length - 5} more` : "";
  const cmdPart = prefs.commands.length === 0
    ? "no verification commands"
    : `verification commands: ${shown}${extra}`;
  return `prefs=updated .gsd/PREFERENCES.md (buckets: ${prefs.buckets.join(", ") || "none"}; ${cmdPart})`;
}

/** The success summary shared verbatim by the /planf3-gsd-build command and
 *  the planf3_gsd_build tool (spec: extract, don't duplicate). */
export function formatBuildSummary(result: BuildResult): string {
  const prefsLine = formatPrefsLine(result.prefs);
  const chainLine = result.autoChain === "not-applicable" ? "" : `\nauto=${result.autoChain}`;
  return `Built milestone ${result.milestoneId ?? "(unknown id)"}\nphase=${result.status.phase}${chainLine}\n${prefsLine}\nspec=${result.specPath}\nmanifest=${result.manifestPath}`;
}

export function registerBuildCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-build", {
    description: "Export the Planf3 plan and create a GSD milestone from it.",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const htmlPath = tokens[0];
      const auto = tokens.includes("--auto");
      const applyPrefs = !tokens.includes("--no-prefs");
      const allowUnsafeStep = tokens.includes("--step-unsafe");
      const force = tokens.includes("--force");
      if (!htmlPath) {
        emit(ctx, "Usage: /planf3-gsd-build <path-to-plan.html> [--auto] [--no-prefs] [--step-unsafe] [--force]", "error");
        return;
      }
      try {
        const result = await runBuild(htmlPath, { auto, applyPrefs, allowUnsafeStep, force });
        emit(ctx, formatBuildSummary(result), "info");
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
}
