// Normalizes gsd_save_gate_result tool arguments before schema validation.
// Models often emit snake_case keys, nest params, or omit milestone/slice when
// auto-mode already has a current unit in scope.

import { getAutoRuntimeSnapshot } from "../auto-runtime-state.js";
import { parseUnitId } from "../unit-id.js";

const GATE_ID_PATTERN = /^(Q[3-8]|MV0[1-4])$/i;

/** Matches `gsd_save_gate_result` TypeBox parameters in db-tools.ts */
export type SaveGateResultToolInput = {
  milestoneId: string;
  sliceId: string;
  gateId: string;
  taskId?: string;
  verdict: string;
  rationale: string;
  findings?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function unwrapNestedArgs(raw: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["arguments", "args", "params", "input", "payload"]) {
    const nested = raw[key];
    if (isRecord(nested)) {
      return { ...nested, ...raw };
    }
  }
  return raw;
}

function normalizeGateId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toUpperCase();
  if (!GATE_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeVerdict(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === "pass" || lower === "flag" || lower === "omitted") return lower;
  if (lower === "passed" || lower === "ok" || lower === "yes") return "pass";
  if (lower === "failed" || lower === "fail" || lower === "concern" || lower === "concerns") return "flag";
  if (lower === "na" || lower === "n/a" || lower === "not_applicable" || lower === "skip") return "omitted";
  return undefined;
}

/**
 * Prepare raw model/MCP arguments for `gsd_save_gate_result` validation.
 * Fills milestoneId/sliceId (and taskId when applicable) from the active auto unit.
 */
export function prepareSaveGateResultArguments(args: unknown): SaveGateResultToolInput {
  if (!isRecord(args)) {
    return args as SaveGateResultToolInput;
  }

  const raw = unwrapNestedArgs(args);
  const out: Record<string, unknown> = { ...raw };

  const milestoneId = pickString(raw, "milestoneId", "milestone_id", "mid", "milestone");
  const sliceId = pickString(raw, "sliceId", "slice_id", "sid", "slice");
  const gateId = normalizeGateId(pickString(raw, "gateId", "gate_id", "gate", "questionId", "question_id"));
  const taskId = pickString(raw, "taskId", "task_id", "tid", "task");
  const verdict = normalizeVerdict(pickString(raw, "verdict", "result", "status", "outcome"));
  const rationale = pickString(raw, "rationale", "reason", "summary", "justification", "explanation");
  const findings = pickString(raw, "findings", "finding", "details", "analysis", "report");

  if (milestoneId) out.milestoneId = milestoneId;
  if (sliceId) out.sliceId = sliceId;
  if (gateId) out.gateId = gateId;
  if (taskId) out.taskId = taskId;
  if (verdict) out.verdict = verdict;
  if (rationale) out.rationale = rationale;
  if (findings) out.findings = findings;

  if (!out.milestoneId || !out.sliceId) {
    const snapshot = getAutoRuntimeSnapshot();
    const unitId = snapshot.currentUnit?.id;
    if (unitId) {
      const parsed = parseUnitId(unitId);
      if (!out.milestoneId && parsed.milestone) out.milestoneId = parsed.milestone;
      if (!out.sliceId && parsed.slice) out.sliceId = parsed.slice;
      if (!out.taskId && parsed.task) out.taskId = parsed.task;
    }
  }

  return out as SaveGateResultToolInput;
}
