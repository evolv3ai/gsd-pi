import { workflowEventArchivePath, workflowEventLogPath } from "./workflow-event-ledger.js";
import { readEvents } from "./workflow-events.js";

export function latestExplicitReopenAt(basePath: string, milestoneId: string): string | null {
  const candidates = [
    workflowEventLogPath(basePath),
    workflowEventArchivePath(basePath, milestoneId),
  ];

  let latest: string | null = null;
  for (const file of candidates) {
    for (const event of readEvents(file)) {
      const eventMilestoneId = (event.params as { milestoneId?: unknown }).milestoneId;
      if (event.cmd !== "reopen-milestone" || eventMilestoneId !== milestoneId) continue;
      if (!latest || event.ts > latest) latest = event.ts;
    }
  }
  return latest;
}

export function isAfter(value: string | null | undefined, cutoff: string | null): boolean {
  if (!cutoff) return true;
  if (!value) return true;
  return Date.parse(value) > Date.parse(cutoff);
}
