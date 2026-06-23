import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runBuild } from "./build.ts";

export function registerBuildCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-build", {
    description: "Export the Planf3 plan and create a GSD milestone from it.",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const htmlPath = tokens[0];
      const auto = tokens.includes("--auto");
      if (!htmlPath) {
        ctx.ui.notify("Usage: /planf3-gsd-build <path-to-plan.html> [--auto]", "error");
        return;
      }
      const result = await runBuild(htmlPath, { auto });
      ctx.ui.notify(
        `Built milestone ${result.milestoneId ?? "(unknown id)"}\nphase=${result.status.phase}\nspec=${result.specPath}\nmanifest=${result.manifestPath}`,
        "info",
      );
    },
  });
}
