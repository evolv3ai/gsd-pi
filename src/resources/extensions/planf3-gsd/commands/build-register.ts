import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runBuild } from "./build.js";
import { friendlyError } from "./error-message.js";

export function registerBuildCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-build", {
    description: "Export the Planf3 plan and create a GSD milestone from it.",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const htmlPath = tokens[0];
      const auto = tokens.includes("--auto");
      const applyPrefs = !tokens.includes("--no-prefs");
      const allowUnsafeStep = tokens.includes("--step-unsafe");
      if (!htmlPath) {
        ctx.ui.notify("Usage: /planf3-gsd-build <path-to-plan.html> [--auto] [--no-prefs] [--step-unsafe]", "error");
        return;
      }
      try {
        const result = await runBuild(htmlPath, { auto, applyPrefs, allowUnsafeStep });
        const prefsLine = result.prefs.warning
          ? `prefs=skipped (${result.prefs.warning})`
          : result.prefs.applied
            ? `prefs=updated .gsd/PREFERENCES.md (models: ${result.prefs.models.join(", ") || "none"}; +${result.prefs.commands.length} verification commands)`
            : "prefs=no changes";
        const chainLine = result.autoChain === "not-applicable" ? "" : `\nauto=${result.autoChain}`;
        ctx.ui.notify(
          `Built milestone ${result.milestoneId ?? "(unknown id)"}\nphase=${result.status.phase}${chainLine}\n${prefsLine}\nspec=${result.specPath}\nmanifest=${result.manifestPath}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(friendlyError(err), "error");
      }
    },
  });
}
