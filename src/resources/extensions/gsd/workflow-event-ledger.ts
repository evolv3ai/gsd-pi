import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteSync } from "./atomic-write.js";
import { resolveGsdPathContract } from "./paths.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./uok/audit.js";
import { isUnifiedAuditEnabled } from "./uok/audit-toggle.js";
import { normalizeWorkflowEventCommand } from "./workflow-event-vocabulary.js";
import type { WorkflowEvent } from "./workflow-events.js";

export const WORKFLOW_EVENT_LOG_FILENAME = "event-log.jsonl";

export interface WorkflowEventLedgerLocation {
  projectRoot: string;
  workRoot: string;
  projectGsd: string;
  worktreeGsd: string | null;
  projectLogPath: string;
  worktreeLogPath: string | null;
  isWorktree: boolean;
}

export type WorkflowEventInput = Omit<WorkflowEvent, "hash" | "session_id"> & {
  actor_name?: string;
  trigger_reason?: string;
};

export function resolveWorkflowEventLedgerLocation(
  basePath: string,
  originalProjectRoot?: string | null,
): WorkflowEventLedgerLocation {
  const contract = resolveGsdPathContract(basePath, originalProjectRoot);
  return {
    projectRoot: contract.projectRoot,
    workRoot: contract.workRoot,
    projectGsd: contract.projectGsd,
    worktreeGsd: contract.worktreeGsd,
    projectLogPath: join(contract.projectGsd, WORKFLOW_EVENT_LOG_FILENAME),
    worktreeLogPath: contract.worktreeGsd
      ? join(contract.worktreeGsd, WORKFLOW_EVENT_LOG_FILENAME)
      : null,
    isWorktree: contract.isWorktree,
  };
}

export function workflowEventLogPath(basePath: string): string {
  return resolveWorkflowEventLedgerLocation(basePath).projectLogPath;
}

export function workflowEventArchivePath(basePath: string, milestoneId: string): string {
  const location = resolveWorkflowEventLedgerLocation(basePath);
  return join(location.projectGsd, `event-log-${milestoneId}.jsonl.archived`);
}

export function readWorktreeEventLogPath(worktreeBasePath: string): string {
  const location = resolveWorkflowEventLedgerLocation(worktreeBasePath);
  return location.worktreeLogPath ?? location.projectLogPath;
}

export function buildWorkflowEvent(event: WorkflowEventInput, sessionId: string): WorkflowEvent {
  const hash = createHash("sha256")
    .update(JSON.stringify({ cmd: event.cmd, params: event.params }))
    .digest("hex")
    .slice(0, 16);

  return {
    v: 2,
    ...event,
    hash,
    session_id: sessionId,
  };
}

export function appendWorkflowEvent(
  basePath: string,
  event: WorkflowEventInput,
  sessionId: string,
): WorkflowEvent {
  const fullEvent = buildWorkflowEvent(event, sessionId);
  const location = resolveWorkflowEventLedgerLocation(basePath);

  mkdirSync(location.projectGsd, { recursive: true });
  appendFileSync(location.projectLogPath, `${JSON.stringify(fullEvent)}\n`, "utf-8");
  emitWorkflowEventAudit(location.projectRoot, fullEvent);
  return fullEvent;
}

export function writeWorkflowEventLog(basePath: string, events: readonly WorkflowEvent[]): void {
  const location = resolveWorkflowEventLedgerLocation(basePath);
  mkdirSync(location.projectGsd, { recursive: true });
  const content = events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
  atomicWriteSync(location.projectLogPath, content);
}

export function writeWorktreeEventLog(
  worktreeBasePath: string,
  events: readonly WorkflowEvent[],
): void {
  const location = resolveWorkflowEventLedgerLocation(worktreeBasePath);
  const logPath = location.worktreeLogPath ?? location.projectLogPath;
  mkdirSync(dirname(logPath), { recursive: true });
  const content = events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
  atomicWriteSync(logPath, content);
}

function emitWorkflowEventAudit(basePath: string, event: WorkflowEvent): void {
  if (!isUnifiedAuditEnabled()) return;
  try {
    const normalized = normalizeWorkflowEventCommand(event.cmd) ?? "unknown";
    emitUokAuditEvent(
      basePath,
      buildAuditEnvelope({
        traceId: event.session_id,
        category: "orchestration",
        type: `workflow-event-${normalized}`,
        payload: {
          cmd: event.cmd,
          params: event.params,
          actor: event.actor,
          actorName: event.actor_name,
          triggerReason: event.trigger_reason,
          eventTs: event.ts,
          hash: event.hash,
        },
      }),
    );
  } catch {
    // Best-effort: audit projection must never block the workflow event ledger.
  }
}
