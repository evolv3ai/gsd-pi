import type { WorkflowEvent } from "./workflow-events.js";

export interface WorkflowEventEntityKey {
  type: string;
  id: string;
}

export function normalizeWorkflowEventCommand(cmd: unknown): string | null {
  return typeof cmd === "string" ? cmd.replace(/-/g, "_") : null;
}

/**
 * Workflow progress events are keyed by the domain entity they mutate.
 * Keep command aliases and conflict identity in this module so replay,
 * conflict detection, and tests do not each grow their own vocabulary.
 */
export function workflowEventEntityKey(event: WorkflowEvent): WorkflowEventEntityKey | null {
  const p = event.params;
  const cmd = normalizeWorkflowEventCommand(event.cmd);
  if (!cmd) return null;

  switch (cmd) {
    case "complete_task":
    case "start_task":
    case "skip_task":
    case "report_blocker":
    case "record_verification":
    case "plan_task":
      return typeof p["taskId"] === "string"
        ? { type: "task", id: p["taskId"] }
        : null;

    case "complete_slice":
    case "replan_slice":
      return typeof p["sliceId"] === "string"
        ? { type: "slice", id: p["sliceId"] }
        : null;

    case "plan_slice":
      return typeof p["sliceId"] === "string"
        ? { type: "slice_plan", id: p["sliceId"] }
        : null;

    case "complete_milestone":
    case "plan_milestone":
      return typeof p["milestoneId"] === "string"
        ? { type: "milestone", id: p["milestoneId"] }
        : null;

    case "save_decision":
      if (typeof p["scope"] === "string" && typeof p["decision"] === "string") {
        return { type: "decision", id: `${p["scope"]}:${p["decision"]}` };
      }
      return null;

    default:
      return null;
  }
}
