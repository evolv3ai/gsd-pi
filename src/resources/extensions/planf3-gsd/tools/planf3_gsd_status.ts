import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runStatusReport, type StatusReport } from "../commands/status.js";
import type { BridgeStatus } from "../gsd/status-mapper.js";
import { friendlyError } from "../commands/error-message.js";
import { emit } from "../gsd/notify.js";

export type StatusToolDetails = StatusReport;

function format(status: BridgeStatus): string {
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
      try {
        const report = await runStatusReport();
        const details: StatusToolDetails = report;
        const text = format(report.status) + (report.nudge !== null ? `\n${report.nudge}` : "");
        return {
          content: [{ type: "text" as const, text }],
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

export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-status", {
    description: "Show GSD build status for this workspace.",
    async handler(_args, ctx) {
      try {
        const report = await runStatusReport();
        const text = format(report.status) + (report.nudge !== null ? `\n${report.nudge}` : "");
        emit(ctx, text, "info");
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
}
