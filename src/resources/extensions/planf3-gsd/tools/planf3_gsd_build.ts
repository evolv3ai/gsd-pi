import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runBuild, type BuildOptions, type AutoChainOutcome } from "../commands/build.js";
import { formatBuildSummary } from "../commands/build-register.js";
import { friendlyError } from "../commands/error-message.js";

export interface BuildToolDetails {
  milestoneId: string | null;
  phase: string;
  autoChain: AutoChainOutcome;
  specPath: string;
  manifestPath: string;
  presets: "ok" | "forced" | "absent" | "drift";
}

/** `overrides` is test-only injection (spawn/cwd/binary/globalPrefsPath) —
 *  same precedent as runBuild's globalPrefsPath. Production passes nothing.
 *  The boolean params always win over overrides. */
export function registerBuildTool(pi: ExtensionAPI, overrides: Partial<BuildOptions> = {}): void {
  pi.registerTool({
    name: "planf3_gsd_build",
    label: "Planf3 → GSD build",
    description:
      "Export a Planf3 HTML plan to a GSD spec and create a GSD milestone from it, optionally running auto mode to completion. Subsumes planf3_gsd_export.",
    promptSnippet: "Build (and optionally auto-run) a GSD milestone from a Planf3 HTML plan.",
    promptGuidelines: [
      "Use when a Planf3 HTML plan exists at a known path and the user wants a GSD milestone created from it.",
      "auto=true (the default) runs the GSD auto loop to completion — real LLM spend. auto=false requires allowUnsafeStep=true and is deadlock-prone in headless sessions.",
    ],
    parameters: Type.Object({
      htmlPath: Type.String({ description: "Path to the Planf3 .html plan." }),
      auto: Type.Optional(Type.Boolean({ description: "Run GSD auto mode after creating the milestone (default true)." })),
      applyPrefs: Type.Optional(Type.Boolean({ description: "Apply the plan's model policy / validation commands to .gsd/PREFERENCES.md (default true)." })),
      force: Type.Optional(Type.Boolean({ description: "Skip the preflight PRESETS gate (default false; recorded as presets=forced in the eval row)." })),
      allowUnsafeStep: Type.Optional(Type.Boolean({ description: "Permit headless step mode despite the known deadlock risk (default false)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await runBuild(params.htmlPath, {
          ...overrides,
          auto: params.auto ?? true,
          applyPrefs: params.applyPrefs ?? true,
          force: params.force ?? false,
          allowUnsafeStep: params.allowUnsafeStep ?? false,
        });
        const details: BuildToolDetails = {
          milestoneId: result.milestoneId,
          phase: result.status.phase,
          autoChain: result.autoChain,
          specPath: result.specPath,
          manifestPath: result.manifestPath,
          presets: result.presets,
        };
        return {
          content: [{ type: "text" as const, text: formatBuildSummary(result) }],
          details,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: friendlyError(err) }],
          isError: true,
          details: undefined as unknown,
        };
      }
    },
  });
}
