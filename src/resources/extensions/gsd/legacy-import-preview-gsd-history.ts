// Project/App: gsd-pi
// File Purpose: Pure preservation-only interpretation of captured legacy workflow event ledgers.

import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
  type LegacyImportSourceLine,
} from "./legacy-import-preview-interpretation.js";
import { parseLegacyImportJson } from "./legacy-import-preview-json.js";
import { hashLegacyImportBytes } from "./legacy-import-preview.js";
import { redactSecrets } from "./redact-secrets.js";
import { normalizeWorkflowEventCommand, workflowEventEntityKey } from "./workflow-event-vocabulary.js";
import type { WorkflowEvent } from "./workflow-events.js";

type SourceFile = LegacyImportDecodedSourceFile;
type PendingCandidate = LegacyImportPendingCandidate;
type PendingDiagnosis = LegacyImportPendingDiagnosis;

interface ParsedEvent {
  file: SourceFile;
  line: LegacyImportSourceLine;
  event: WorkflowEvent;
  command: string;
  order: number;
  timestamp: number;
  sensitivePointer?: string;
}

const ACTIVE_PATH = ".gsd/event-log.jsonl";
const KNOWN_COMMANDS = new Set([
  "complete_milestone",
  "complete_slice",
  "complete_task",
  "plan_milestone",
  "plan_slice",
  "plan_task",
  "reassess_roadmap",
  "record_verification",
  "reopen_milestone",
  "reopen_slice",
  "reopen_task",
  "replan_slice",
  "replan_task",
  "report_blocker",
  "save_decision",
  "skip_task",
  "start_task",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointerToken(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function sensitivePointer(value: unknown, pointer = ""): string | undefined {
  if (typeof value === "string") return redactSecrets(value) === value ? undefined : pointer;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = sensitivePointer(child, `${pointer}/${index}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const found = sensitivePointer(child, `${pointer}/${pointerToken(key)}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isWorkflowLedger(path: string): boolean {
  return path === ACTIVE_PATH
    || /^\.gsd\/event-log-M[^/]+\.jsonl\.archived$/u.test(path)
    || /^\.gsd-worktrees\/[^/]+\/\.gsd\/event-log\.jsonl$/u.test(path)
    || /^\.gsd\/worktrees\/[^/]+\/\.gsd\/event-log\.jsonl$/u.test(path)
    || /^\$GSD_STATE_DIR\/projects\/[^/]+\/worktrees\/[^/]+\/\.gsd\/event-log\.jsonl$/u.test(path);
}

function isWorktreeLedger(path: string): boolean {
  return path.startsWith(".gsd-worktrees/") || path.startsWith(".gsd/worktrees/");
}

function isExternalLedger(path: string): boolean {
  return path.startsWith("$GSD_STATE_DIR/");
}

function isArchivedLedger(path: string): boolean {
  return path.endsWith(".jsonl.archived");
}

function validEvent(value: unknown): value is WorkflowEvent {
  if (!isRecord(value) || (value.v !== undefined && value.v !== 2)) return false;
  return typeof value.cmd === "string"
    && value.cmd.length > 0
    && isRecord(value.params)
    && typeof value.ts === "string"
    && Number.isFinite(Date.parse(value.ts))
    && typeof value.hash === "string"
    && value.hash.length > 0
    && (value.actor === "agent" || value.actor === "system")
    && typeof value.session_id === "string"
    && value.session_id.length > 0;
}

function markLedger(file: SourceFile): void {
  file.parserId = "gsd-workflow-events";
  file.parserVersion = "2";
  file.kind = "jsonl";
}

function diagnoseCorruptLine(file: SourceFile, line: LegacyImportSourceLine, diagnoses: PendingDiagnosis[]): void {
  file.outcome = "unparsed";
  addLegacyImportDiagnosis(
    diagnoses,
    file,
    "corrupt-jsonl-line",
    "warning",
    "The corrupt JSONL line cannot be interpreted and remains preserved as raw history evidence.",
    "preserved",
    line.start,
    line.end,
  );
}

function parseLedger(file: SourceFile, diagnoses: PendingDiagnosis[]): ParsedEvent[] {
  markLedger(file);
  if (file.encoding !== "utf-8") {
    file.outcome = "unparsed";
    addLegacyImportDiagnosis(
      diagnoses, file, "unsupported-workflow-history-encoding", "warning",
      "Workflow history must be valid UTF-8 and remains retained without interpretation.", "preserved",
    );
    return [];
  }
  if (file.lines.every((line) => line.text.trim().length === 0)) {
    file.outcome = "ignored-with-reason";
    addLegacyImportDiagnosis(
      diagnoses, file, "empty-worktree-ledger-excluded", "info",
      "The empty worktree shard carries no workflow history and is explicitly excluded.", "preserved",
    );
    return [];
  }

  file.outcome = "preserved";
  const parsed: ParsedEvent[] = [];
  for (const line of file.lines) {
    if (line.text.trim().length === 0) continue;
    let document;
    try {
      document = parseLegacyImportJson(file.bytes.subarray(line.start, line.end));
    } catch {
      diagnoseCorruptLine(file, line, diagnoses);
      continue;
    }
    if (!validEvent(document.value)) {
      file.outcome = "unparsed";
      addLegacyImportDiagnosis(
        diagnoses, file, "malformed-workflow-event", "warning",
        "The JSONL row is valid JSON but not a supported workflow event and remains raw evidence.", "preserved",
        line.start, line.end,
      );
      continue;
    }
    const command = normalizeWorkflowEventCommand(document.value.cmd)!;
    parsed.push({
      file,
      line,
      event: document.value,
      command,
      order: line.line,
      timestamp: Date.parse(document.value.ts),
      sensitivePointer: sensitivePointer(document.value),
    });
  }
  return parsed;
}

function addSensitiveDiagnosis(value: ParsedEvent, diagnoses: PendingDiagnosis[]): void {
  const document = parseLegacyImportJson(value.file.bytes.subarray(value.line.start, value.line.end));
  const token = document.locate(value.sensitivePointer!);
  const start = value.line.start + token.start_byte;
  const end = value.line.start + token.end_byte;
  addLegacyImportDiagnosis(
    diagnoses,
    value.file,
    "secret-shaped-history-evidence",
    "warning",
    "Secret-shaped content was found in preserved workflow history; diagnostic presentation is redacted.",
    "preserved",
    start,
    end,
    undefined,
    { redacted: true, sha256: hashLegacyImportBytes(value.file.bytes.subarray(start, end)) },
  );
}

function worktreeReason(value: ParsedEvent, activeEvent: ParsedEvent | undefined): string {
  if (isExternalLedger(value.file.entry.logical_path)) return "external-worktree-history-evidence-only";
  return activeEvent?.event.hash === value.event.hash
    ? "fork-base-history-preserved"
    : "fork-branch-history-preserved";
}

function baseReason(value: ParsedEvent, activeEvent: ParsedEvent | undefined): string {
  const path = value.file.entry.logical_path;
  if (isArchivedLedger(path)) return "archived-history-evidence-only";
  if (isWorktreeLedger(path) || isExternalLedger(path)) return worktreeReason(value, activeEvent);
  return "history-evidence-only";
}

function addForkDiagnosis(file: SourceFile, events: readonly ParsedEvent[], active: readonly ParsedEvent[], diagnoses: PendingDiagnosis[]): void {
  if (!isWorktreeLedger(file.entry.logical_path) || events.length === 0) return;
  const divergence = events.findIndex((event, index) => active[index]?.event.hash !== event.event.hash);
  if (divergence === -1 && events.length <= active.length) return;
  const evidence = events[divergence === -1 ? active.length : divergence];
  if (evidence === undefined) return;
  const canonical = file.entry.logical_path.startsWith(".gsd-worktrees/");
  addLegacyImportDiagnosis(
    diagnoses, file, "history-fork-preserved", "info",
    `The ${canonical ? "canonical" : "legacy"} worktree ledger diverges after the shared first event and remains history-only evidence.`,
    "preserved",
    evidence.line.start,
    evidence.line.end,
  );
}

function emitEvents(
  file: SourceFile,
  events: readonly ParsedEvent[],
  active: readonly ParsedEvent[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  const hashes = new Set<string>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const [eventIndex, value] of events.entries()) {
    const duplicate = hashes.has(value.event.hash);
    const outOfOrder = value.timestamp < previousTimestamp;
    hashes.add(value.event.hash);
    previousTimestamp = value.timestamp;
    if (value.sensitivePointer !== undefined) {
      addSensitiveDiagnosis(value, diagnoses);
      continue;
    }

    const known = KNOWN_COMMANDS.has(value.command);
    const authority = value.event.params["authorityContext"];
    let reason = baseReason(value, active[eventIndex]);
    if (!known) reason = "unknown-history-event-preserved";
    else if (duplicate) reason = "duplicate-history-evidence-preserved";
    else if (outOfOrder) reason = "out-of-order-history-evidence-preserved";
    else if (authority === "adopted") reason = "adopted-history-evidence-only";
    else if (authority === "legacy-only") reason = "unadopted-history-evidence-only";

    const entity = workflowEventEntityKey(value.event);
    addLegacyImportCandidate(
      candidates,
      file,
      { kind: "legacy-workflow-event", key: `${file.entry.logical_path}#L${String(value.order).padStart(3, "0")}` },
      {
        replay_policy: "evidence-only",
        event_version: value.event.v === 2 ? 2 : 1,
        command: value.command,
        entity: entity === null ? null : { type: entity.type, id: entity.id },
        authority_context: authority === "adopted" || authority === "legacy-only" ? authority : null,
        file_order: value.order,
      },
      reason,
      value.line.start,
      value.line.end,
      "preserve",
    );

    if (!known) {
      addLegacyImportDiagnosis(
        diagnoses, file, "unknown-workflow-command", "warning",
        "The command is not in the current workflow vocabulary and remains history-only evidence.", "preserved",
        value.line.start, value.line.end,
      );
    }
    if (duplicate) {
      addLegacyImportDiagnosis(
        diagnoses, file, "duplicate-event-hash", "info",
        "The repeated event hash is retained in file order without deduplication or replay.", "preserved",
        value.line.start, value.line.end,
      );
    }
    if (outOfOrder) {
      addLegacyImportDiagnosis(
        diagnoses, file, "out-of-order-event", "warning",
        "The event timestamp is earlier than preceding rows; file order is retained without replay sorting.", "preserved",
        value.line.start, value.line.end,
      );
    }
  }
  addForkDiagnosis(file, events, active, diagnoses);
}

export function interpretLegacyGsdHistory(
  files: readonly SourceFile[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.entry.logical_path !== ".gsd/doctor-history.jsonl") continue;
    file.parserId = "legacy-jsonl-exclusion";
    file.parserVersion = "1";
    file.kind = "jsonl";
    file.outcome = "ignored-with-reason";
    const line = file.lines[0];
    addLegacyImportDiagnosis(
      diagnoses, file, "non-workflow-jsonl-excluded", "info",
      "Doctor history is JSONL but is not a workflow event ledger and is explicitly excluded.", "preserved",
      line?.start, line?.end,
    );
  }

  const ledgers = files.filter((file) => isWorkflowLedger(file.entry.logical_path));
  const parsed = new Map(ledgers.map((file) => [file, parseLedger(file, diagnoses)]));
  const active = ledgers.find((file) => file.entry.logical_path === ACTIVE_PATH);
  const activeEvents = active === undefined ? [] : parsed.get(active) ?? [];
  for (const file of ledgers) emitEvents(file, parsed.get(file) ?? [], activeEvents, candidates, diagnoses);
}
