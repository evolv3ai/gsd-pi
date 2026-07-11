import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runSync, type SyncOutcome } from "../commands/sync.js";
import { friendlyError } from "../commands/error-message.js";

export type SyncToolDetails = SyncOutcome;

export function registerSyncTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "planf3_gsd_sync",
    label: "Planf3 GSD sync",
    description:
      "Pull GSD runtime state back into the Planf3 HTML plan: raise status markers ([] / [wip] / [x] / [f]) monotonically from gsd headless query and upsert the gsd milestone/session metadata rows. Set dryRun to preview changes without writing.",
    promptSnippet: "Sync GSD build state back into the Planf3 plan.",
    promptGuidelines: [
      "Run after a build progresses or completes so the HTML plan reflects GSD state.",
      "Use dryRun: true first when the user wants to review the changes before writing.",
    ],
    parameters: Type.Object({
      htmlPath: Type.Optional(Type.String()),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const outcome = await runSync(params.htmlPath ?? null, params.dryRun === true, { cwd: ctx.cwd });
        const details: SyncToolDetails = outcome;
        return {
          content: [{ type: "text" as const, text: outcome.message }],
          isError: outcome.kind === "not-located" || outcome.kind === "aborted",
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
