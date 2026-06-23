import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runExport } from "../commands/export.js";
import { friendlyError } from "../commands/error-message.js";

export interface ExportToolDetails {
  phaseCount: number;
  taskCount: number;
  specPath: string;
  manifestPath: string;
}

export function registerExportTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "planf3_gsd_export",
    label: "Planf3 → GSD export",
    description: "Convert a Planf3 HTML plan into a GSD spec markdown file and bridge manifest beside it.",
    promptSnippet: "Export a Planf3 HTML plan to a GSD spec.",
    promptGuidelines: ["Use when the user has a Planf3 HTML plan at a known path and wants to feed it into GSD."],
    parameters: Type.Object({
      htmlPath: Type.String({ description: "Path to the Planf3 .html plan." }),
      mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("step")])),
      userPrompt: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await runExport(params.htmlPath, {
          mode: params.mode,
          userPrompt: params.userPrompt ?? null,
        });
        const details: ExportToolDetails = {
          phaseCount: result.phaseCount,
          taskCount: result.taskCount,
          specPath: result.specPath,
          manifestPath: result.manifestPath,
        };
        return {
          content: [{
            type: "text" as const,
            text: `Exported ${result.phaseCount} phases (${result.taskCount} tasks) to ${result.specPath} and ${result.manifestPath}.`,
          }],
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

export function registerExportCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-export", {
    description: "Export a Planf3 HTML plan to a GSD spec + manifest.",
    async handler(args, ctx) {
      const htmlPath = args.trim();
      if (!htmlPath) {
        ctx.ui.notify("Usage: /planf3-gsd-export <path-to-plan.html>", "error");
        return;
      }
      try {
        const result = await runExport(htmlPath);
        ctx.ui.notify(
          `Exported → ${result.specPath}\n             ${result.manifestPath}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(friendlyError(err), "error");
      }
    },
  });
}
