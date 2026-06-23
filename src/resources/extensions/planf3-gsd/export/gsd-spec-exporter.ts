import type { ParsedPlan, PlanFile, PlanPhase } from "../parser/types.js";
import { STATUS_TO_MARKER } from "../parser/types.js";

export interface ExportCtx {
  htmlPath: string;
  manifestPath: string;
  generatedAt: string;
}

function renderFiles(label: string, files: PlanFile[]): string {
  if (files.length === 0) return `### ${label}\n_None._\n`;
  const lines = files.map((f) => `- \`${f.path}\` — ${f.description}`);
  return `### ${label}\n${lines.join("\n")}\n`;
}

function renderChecklist(checklist: { status: string; text: string }[]): string {
  return checklist
    .map((item) => {
      const box = item.status === "done" ? "[x]"
        : item.status === "wip" ? "[~]"
        : item.status === "failed" ? "[!]"
        : "[ ]";
      return `- ${box} ${item.text}`;
    })
    .join("\n");
}

function renderPhase(phase: PlanPhase): string {
  const marker = STATUS_TO_MARKER[phase.status].replace("[]", "[ ]");
  const head = `### ${phase.title} ${marker}`;
  const desc = phase.description ? `\n\n${phase.description}` : "";
  const tasks = phase.tasks.map((t) => {
    const body = t.checklist.length === 0 ? "_No checklist._" : renderChecklist(t.checklist);
    return `#### ${t.title}\n${body}`;
  });
  return [head + desc, ...tasks].join("\n\n");
}

export function exportGsdSpec(plan: ParsedPlan, ctx: ExportCtx): string {
  const parts: string[] = [];
  parts.push(`# ${plan.title}`);
  if (plan.tagline) parts.push(`> ${plan.tagline}`);
  parts.push(
    `## Source\n\n- Planf3 HTML: ${ctx.htmlPath}\n- Manifest: ${ctx.manifestPath}\n- Generated: ${ctx.generatedAt}`,
  );
  parts.push(`## Objective\n\n${plan.purpose || "_Not provided._"}`);
  parts.push(`## Problem\n\n${plan.problem || "_Not provided._"}`);
  parts.push(`## Proposed Solution\n\n${plan.solution || "_Not provided._"}`);
  parts.push(
    `## Relevant Files\n\n${renderFiles("Existing Files", plan.existingFiles)}\n${renderFiles("New Files", plan.newFiles)}`,
  );
  parts.push(`## Milestone Scope\n\n${plan.purpose || plan.solution || "_Defined by phases below._"}`);
  parts.push(`## Implementation Phases\n\n${plan.phases.map(renderPhase).join("\n\n")}`);
  parts.push(
    `## Validation Commands\n${plan.validationCommands.length === 0 ? "_None._" : plan.validationCommands.map((c) => `- ${c}`).join("\n")}`,
  );
  parts.push(`## Constraints\n\n${plan.notes || "_None._"}`);
  parts.push(
    `## Open Decisions\n${plan.openDecisions.length === 0 ? "_None._" : plan.openDecisions.map((q) => `- ${q}`).join("\n")}`,
  );
  return parts.join("\n\n") + "\n";
}
