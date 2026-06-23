import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runStatus } from "../commands/status.js";

function format(status: Awaited<ReturnType<typeof runStatus>>): string {
  const am = status.activeMilestone ? `${status.activeMilestone.id} (${status.activeMilestone.title})` : "—";
  const at = status.activeTask ? `${status.activeTask.id} (${status.activeTask.title})` : "—";
  const p = status.progress;
  const prog = p
    ? `milestones ${p.milestones.done}/${p.milestones.total} · slices ${p.slices.done}/${p.slices.total} · tasks ${p.tasks.done}/${p.tasks.total}`
    : "—";
  const blockers = status.blockers.length === 0 ? "none" : `${status.blockers.length}`;
  return [
    `phase:           ${status.phase}`,
    `active milestone: ${am}`,
    `active task:      ${at}`,
    `progress:         ${prog}`,
    `cost:            ${status.cost.toFixed(2)}`,
    `next:            ${status.nextAction ?? "—"}`,
    `blockers:        ${blockers}`,
  ].join("\n");
}

export function registerStatusTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "planf3_gsd_status",
    label: "Planf3 GSD status",
    description: "Report the current GSD milestone phase, active task, progress, and cost via gsd headless query.",
    promptSnippet: "Show GSD status for the current project.",
    promptGuidelines: ["Use whenever the user asks how the GSD build is progressing."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const status = await runStatus();
      return {
        content: [{ type: "text" as const, text: format(status) }],
        details: undefined as unknown,
      };
    },
  });
}

export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-status", {
    description: "Show GSD build status for this workspace.",
    async handler(_args, ctx) {
      const status = await runStatus();
      ctx.ui.notify(format(status), "info");
    },
  });
}
