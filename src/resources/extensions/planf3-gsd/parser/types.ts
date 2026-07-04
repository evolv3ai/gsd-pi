export type PlanStatus = "todo" | "wip" | "done" | "failed";

export interface PlanMetadata {
  created: string | null;
  modified: string[];
  commits: string[];
  agentName: string | null;
  sessionId: string | null;
  backRefs: string[];
  forwardRefs: string[];
}

export interface PlanFile {
  kind: "existing" | "new";
  path: string;
  description: string;
}

export interface PlanChecklistItem {
  status: PlanStatus;
  text: string;
  /** Text of the first non-status <code> element — the executable command, when the item carries one. */
  command: string | null;
}

export interface PlanTask {
  title: string;
  checklist: PlanChecklistItem[];
}

export interface PlanPhase {
  title: string;
  status: PlanStatus;
  description: string;
  tasks: PlanTask[];
}

export interface PlanAmendment {
  iso: string;
  summary: string;
  body: string;
}

export interface ParsedPlan {
  title: string;
  tagline: string | null;
  metadata: PlanMetadata;
  purpose: string;
  problem: string;
  solution: string;
  existingFiles: PlanFile[];
  newFiles: PlanFile[];
  phases: PlanPhase[];
  validationCommands: string[];
  notes: string;
  amendments: PlanAmendment[];
  openDecisions: string[];
}

export const STATUS_FROM_MARKER: Record<string, PlanStatus> = {
  "[]": "todo",
  "[wip]": "wip",
  "[x]": "done",
  "[f]": "failed",
};

export const STATUS_TO_MARKER: Record<PlanStatus, string> = {
  todo: "[]",
  wip: "[wip]",
  done: "[x]",
  failed: "[f]",
};
