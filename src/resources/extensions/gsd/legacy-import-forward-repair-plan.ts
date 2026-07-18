// Project/App: gsd-pi
// File Purpose: Pure three-way Forward Repair planning for one retained Import Application.

import type { LegacyImportValue } from "./legacy-import-contract.js";
import type {
  LegacyImportApplicationPlan,
  LegacyImportApplicationPlanInstruction,
} from "./legacy-import-application-plan.js";
import type {
  LegacyImportBaseRow,
  LegacyImportBaseRowSet,
  LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import { canonicalLegacyImportJson, hashLegacyImportValue } from "./legacy-import-preview.js";

export const LEGACY_IMPORT_FORWARD_REPAIR_PLAN_SCHEMA_VERSION = 1 as const;

export type LegacyImportForwardRepairDisposition =
  | "safe-revert"
  | "already-repaired"
  | "later-modified"
  | "conflict"
  | "preserve"
  | "choice-required";

type SqlValue = null | number | string;
type SqlRecord = Readonly<Record<string, SqlValue>>;

export interface LegacyImportForwardRepairRowMutation {
  readonly action: "create" | "update" | "delete";
  readonly rowSet: LegacyImportBaseRowSet;
  readonly identity: SqlRecord;
  readonly values: SqlRecord;
}

export interface LegacyImportForwardRepairDependencyMutation {
  readonly action: "replace-slice-dependencies";
  readonly milestoneId: string;
  readonly sliceId: string;
  readonly dependsOnSliceIds: readonly string[];
}

export interface LegacyImportForwardRepairDecisionMutation {
  readonly action: "restore-decision-memory" | "delete-decision-memory";
  readonly decisionId: string;
  readonly structuredFields: string | null;
}

export type LegacyImportForwardRepairMutation =
  | LegacyImportForwardRepairRowMutation
  | LegacyImportForwardRepairDependencyMutation
  | LegacyImportForwardRepairDecisionMutation;

export interface LegacyImportForwardRepairTarget {
  readonly instructionIndex: number;
  readonly targetKind: string;
  readonly targetKey: string;
  readonly changeIds: readonly string[];
  readonly disposition: LegacyImportForwardRepairDisposition;
  readonly reasonCode: string;
  readonly mutation: LegacyImportForwardRepairMutation | null;
}

export interface LegacyImportForwardRepairPlan {
  readonly planSchemaVersion: typeof LEGACY_IMPORT_FORWARD_REPAIR_PLAN_SCHEMA_VERSION;
  readonly applicationOperationId: string;
  readonly applicationIdentityHash: string;
  readonly previewId: string;
  readonly previewHash: string;
  readonly backupId: string;
  readonly differenceHash: string;
  readonly expectedProjectRevision: number;
  readonly expectedAuthorityEpoch: number;
  readonly baseRelevantRowsHash: string;
  readonly applicationRelevantRowsHash: string;
  readonly currentRelevantRowsHash: string;
  readonly targetCount: number;
  readonly mutationCount: number;
  readonly preservedCount: number;
  readonly rejectedCount: number;
  readonly unresolvedCount: number;
  readonly targets: readonly LegacyImportForwardRepairTarget[];
}

export interface LegacyImportForwardRepairPlanInput {
  readonly applicationOperationId: string;
  readonly applicationIdentityHash: string;
  readonly applicationRelevantRowsHash: string;
  readonly previewId: string;
  readonly previewHash: string;
  readonly backupId: string;
  readonly applicationPlan: Readonly<LegacyImportApplicationPlan>;
  readonly backupBase: Readonly<LegacyImportBaseSnapshot>;
  readonly currentBase: Readonly<LegacyImportBaseSnapshot>;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalLegacyImportJson(left as LegacyImportValue)
    === canonicalLegacyImportJson(right as LegacyImportValue);
}

function rowKey(rowSet: LegacyImportBaseRowSet, identity: string): string {
  return `${rowSet}\0${identity}`;
}

function rowIndex(snapshot: Readonly<LegacyImportBaseSnapshot>): Map<string, LegacyImportBaseRow> {
  return new Map(snapshot.rows.map((row) => [rowKey(row.row_set, row.identity), row]));
}

function instructionIdentity(instruction: Extract<LegacyImportApplicationPlanInstruction, {
  action: "create" | "update" | "delete";
}>): string {
  return canonicalLegacyImportJson(instruction.identity as unknown as LegacyImportValue);
}

function target(
  instruction: LegacyImportApplicationPlanInstruction,
  instructionIndex: number,
  disposition: LegacyImportForwardRepairDisposition,
  reasonCode: string,
  mutation: LegacyImportForwardRepairMutation | null = null,
): LegacyImportForwardRepairTarget {
  return {
    instructionIndex,
    targetKind: instruction.targetKind,
    targetKey: instruction.targetKey,
    changeIds: [...instruction.changeIds],
    disposition,
    reasonCode,
    mutation,
  };
}

function rowTarget(
  instruction: Extract<LegacyImportApplicationPlanInstruction, {
    action: "create" | "update" | "delete";
  }>,
  instructionIndex: number,
  backupRows: ReadonlyMap<string, LegacyImportBaseRow>,
  currentRows: ReadonlyMap<string, LegacyImportBaseRow>,
  currentBase: Readonly<LegacyImportBaseSnapshot>,
): LegacyImportForwardRepairTarget {
  const identity = instructionIdentity(instruction);
  const key = rowKey(instruction.rowSet, identity);
  const base = backupRows.get(key)?.value;
  const current = currentRows.get(key)?.value;

  if (instruction.action === "create") {
    if (current === undefined) {
      return target(instruction, instructionIndex, "already-repaired", "CREATED_ROW_ABSENT");
    }
    if (!sameValue(current, instruction.values)) {
      return target(instruction, instructionIndex, "later-modified", "CREATED_ROW_CHANGED_LATER");
    }
    if (
      (instruction.targetKind === "milestone"
        || instruction.targetKind === "slice"
        || instruction.targetKind === "task")
      && currentBase.rows.some((row) => row.row_set === "item_lifecycles"
        && row.value["project_id"] === currentBase.authority.project_id
        && row.value["item_kind"] === instruction.targetKind
        && row.value["milestone_id"]
          === (instruction.targetKind === "milestone" ? instruction.identity["id"] : instruction.identity["milestone_id"])
        && row.value["slice_id"]
          === (instruction.targetKind === "milestone" ? null : instruction.identity["slice_id"])
        && row.value["task_id"]
          === (instruction.targetKind === "task" ? instruction.identity["id"] : null))
    ) {
      return target(instruction, instructionIndex, "preserve", "IMMUTABLE_LIFECYCLE_DEPENDENCY");
    }
    return target(instruction, instructionIndex, "safe-revert", "CREATED_ROW_UNCHANGED", {
      action: "delete",
      rowSet: instruction.rowSet,
      identity: instruction.identity,
      values: {},
    });
  }

  if (instruction.action === "delete") {
    if (base === undefined) {
      return target(instruction, instructionIndex, "conflict", "DELETED_ROW_MISSING_FROM_BACKUP");
    }
    if (current === undefined) {
      return target(instruction, instructionIndex, "safe-revert", "DELETED_ROW_STILL_ABSENT", {
        action: "create",
        rowSet: instruction.rowSet,
        identity: instruction.identity,
        values: base as SqlRecord,
      });
    }
    if (sameValue(current, base)) {
      return target(instruction, instructionIndex, "already-repaired", "DELETED_ROW_ALREADY_RESTORED");
    }
    return target(instruction, instructionIndex, "later-modified", "DELETED_ROW_RECREATED_LATER");
  }

  if (base === undefined) {
    return target(instruction, instructionIndex, "conflict", "UPDATED_ROW_MISSING_FROM_BACKUP");
  }
  if (current === undefined) {
    return target(instruction, instructionIndex, "later-modified", "UPDATED_ROW_DELETED_LATER");
  }
  const restore: Record<string, SqlValue> = {};
  for (const [field, importedValue] of Object.entries(instruction.values)) {
    const currentValue = current[field];
    const baseValue = base[field];
    if (sameValue(currentValue, baseValue)) continue;
    if (!sameValue(currentValue, importedValue)) {
      return target(instruction, instructionIndex, "choice-required", "UPDATED_FIELD_CHANGED_LATER");
    }
    restore[field] = baseValue as SqlValue;
  }
  if (Object.keys(restore).length === 0) {
    return target(instruction, instructionIndex, "already-repaired", "UPDATED_FIELDS_ALREADY_RESTORED");
  }
  return target(instruction, instructionIndex, "safe-revert", "UPDATED_FIELDS_UNCHANGED", {
    action: "update",
    rowSet: instruction.rowSet,
    identity: instruction.identity,
    values: restore,
  });
}

function dependencySet(
  snapshot: Readonly<LegacyImportBaseSnapshot>,
  milestoneId: string,
  sliceId: string,
): string[] {
  return snapshot.rows
    .filter((row) => row.row_set === "slice_dependencies"
      && row.value["milestone_id"] === milestoneId
      && row.value["slice_id"] === sliceId)
    .map((row) => String(row.value["depends_on_slice_id"]))
    .sort();
}

function dependencyTarget(
  instruction: Extract<LegacyImportApplicationPlanInstruction, {
    action: "replace-slice-dependencies" | "delete-slice-dependencies";
  }>,
  instructionIndex: number,
  backupBase: Readonly<LegacyImportBaseSnapshot>,
  currentBase: Readonly<LegacyImportBaseSnapshot>,
): LegacyImportForwardRepairTarget {
  const base = dependencySet(backupBase, instruction.milestoneId, instruction.sliceId);
  const current = dependencySet(currentBase, instruction.milestoneId, instruction.sliceId);
  const imported = instruction.action === "replace-slice-dependencies"
    ? [...instruction.dependsOnSliceIds]
    : [];
  if (sameValue(current, base)) {
    return target(instruction, instructionIndex, "already-repaired", "DEPENDENCIES_ALREADY_RESTORED");
  }
  if (!sameValue(current, imported)) {
    return target(instruction, instructionIndex, "choice-required", "DEPENDENCIES_CHANGED_LATER");
  }
  return target(instruction, instructionIndex, "safe-revert", "DEPENDENCIES_UNCHANGED", {
    action: "replace-slice-dependencies",
    milestoneId: instruction.milestoneId,
    sliceId: instruction.sliceId,
    dependsOnSliceIds: base,
  });
}

function decisionRow(
  snapshot: Readonly<LegacyImportBaseSnapshot>,
  rowSet: "decisions" | "decision_memories",
  decisionId: string,
): LegacyImportBaseRow | undefined {
  const identity = rowSet === "decisions"
    ? canonicalLegacyImportJson({ id: decisionId })
    : canonicalLegacyImportJson({ source_decision_id: decisionId });
  return snapshot.rows.find((row) => row.row_set === rowSet && row.identity === identity);
}

function decisionFieldsFromBackup(
  backupBase: Readonly<LegacyImportBaseSnapshot>,
  decisionId: string,
): { fields: Record<string, LegacyImportValue>; structuredFields: string | null } | null {
  const memory = decisionRow(backupBase, "decision_memories", decisionId);
  if (memory) {
    const structuredFields = String(memory.value["structured_fields"]);
    const parsed = JSON.parse(structuredFields) as Record<string, LegacyImportValue>;
    return { fields: { ...parsed, id: decisionId }, structuredFields };
  }
  const legacy = decisionRow(backupBase, "decisions", decisionId);
  if (!legacy) return null;
  return { fields: { ...legacy.value }, structuredFields: null };
}

function expectedDecisionFields(
  instruction: Extract<LegacyImportApplicationPlanInstruction, {
    action: "create-decision-memory" | "update-decision-memory" | "delete-decision-memory";
  }>,
  backupBase: Readonly<LegacyImportBaseSnapshot>,
): string | null {
  const base = decisionFieldsFromBackup(backupBase, instruction.decisionId);
  if (instruction.action !== "create-decision-memory" && base === null) return null;
  const fields: Record<string, LegacyImportValue> = instruction.action === "create-decision-memory"
    ? { ...instruction.values }
    : { ...base!.fields, ...instruction.values, id: instruction.decisionId };
  const structured: Record<string, LegacyImportValue> = {
    sourceDecisionId: instruction.decisionId,
  };
  for (const field of [
    "when_context", "scope", "decision", "choice", "rationale",
    "revisable", "made_by", "source", "superseded_by",
  ]) {
    structured[field] = fields[field] ?? null;
  }
  structured.deleted = instruction.action === "delete-decision-memory";
  return canonicalLegacyImportJson(structured);
}

function currentDecisionFields(
  currentBase: Readonly<LegacyImportBaseSnapshot>,
  decisionId: string,
): string | null {
  const memory = decisionRow(currentBase, "decision_memories", decisionId);
  return memory ? String(memory.value["structured_fields"]) : null;
}

function decisionTarget(
  instruction: Extract<LegacyImportApplicationPlanInstruction, {
    action: "create-decision-memory" | "update-decision-memory" | "delete-decision-memory";
  }>,
  instructionIndex: number,
  backupBase: Readonly<LegacyImportBaseSnapshot>,
  currentBase: Readonly<LegacyImportBaseSnapshot>,
): LegacyImportForwardRepairTarget {
  const base = decisionFieldsFromBackup(backupBase, instruction.decisionId);
  const current = currentDecisionFields(currentBase, instruction.decisionId);
  const imported = expectedDecisionFields(instruction, backupBase);
  if (imported === null) {
    return target(instruction, instructionIndex, "conflict", "DECISION_MISSING_FROM_BACKUP");
  }
  if (current === (base?.structuredFields ?? null)) {
    return target(instruction, instructionIndex, "already-repaired", "DECISION_ALREADY_RESTORED");
  }
  if (current !== imported) {
    return target(instruction, instructionIndex, "choice-required", "DECISION_CHANGED_LATER");
  }
  return target(instruction, instructionIndex, "safe-revert", "DECISION_UNCHANGED", base?.structuredFields
    ? {
        action: "restore-decision-memory",
        decisionId: instruction.decisionId,
        structuredFields: base.structuredFields,
      }
    : {
        action: "delete-decision-memory",
        decisionId: instruction.decisionId,
        structuredFields: null,
      });
}

function compileTarget(
  instruction: LegacyImportApplicationPlanInstruction,
  instructionIndex: number,
  backupBase: Readonly<LegacyImportBaseSnapshot>,
  currentBase: Readonly<LegacyImportBaseSnapshot>,
  backupRows: ReadonlyMap<string, LegacyImportBaseRow>,
  currentRows: ReadonlyMap<string, LegacyImportBaseRow>,
): LegacyImportForwardRepairTarget {
  if (instruction.action === "create" || instruction.action === "update" || instruction.action === "delete") {
    return rowTarget(instruction, instructionIndex, backupRows, currentRows, currentBase);
  }
  if (instruction.action === "replace-slice-dependencies" || instruction.action === "delete-slice-dependencies") {
    return dependencyTarget(instruction, instructionIndex, backupBase, currentBase);
  }
  if (
    instruction.action === "create-decision-memory"
    || instruction.action === "update-decision-memory"
    || instruction.action === "delete-decision-memory"
  ) {
    return decisionTarget(instruction, instructionIndex, backupBase, currentBase);
  }
  if (instruction.action === "adopt-lifecycle") {
    return target(instruction, instructionIndex, "preserve", "IMMUTABLE_LIFECYCLE_HISTORY");
  }
  return target(instruction, instructionIndex, "preserve", "APPLICATION_PRESERVED_TARGET");
}

export function compileLegacyImportForwardRepairPlan(
  input: Readonly<LegacyImportForwardRepairPlanInput>,
): LegacyImportForwardRepairPlan {
  if (
    input.backupBase.authority.project_id !== input.currentBase.authority.project_id
    || input.backupBase.authority.revision !== input.applicationPlan.baseProjectRevision
    || input.backupBase.authority.authority_epoch !== input.applicationPlan.baseAuthorityEpoch
    || input.applicationPlan.previewId !== input.previewId
    || input.applicationPlan.previewHash !== input.previewHash
  ) {
    throw new Error("Forward Repair base and Application evidence are inconsistent");
  }
  const backupRows = rowIndex(input.backupBase);
  const currentRows = rowIndex(input.currentBase);
  const targets = input.applicationPlan.instructions.map((instruction, index) => compileTarget(
    instruction,
    index,
    input.backupBase,
    input.currentBase,
    backupRows,
    currentRows,
  ));
  const mutationCount = targets.filter((entry) => entry.mutation !== null).length;
  const preservedCount = targets.filter((entry) => (
    entry.disposition === "already-repaired"
    || entry.disposition === "later-modified"
    || entry.disposition === "preserve"
  )).length;
  const rejectedCount = targets.filter((entry) => entry.disposition === "conflict").length;
  const unresolvedCount = targets.filter((entry) => entry.disposition === "choice-required").length;
  const differenceHash = hashLegacyImportValue({
    applicationOperationId: input.applicationOperationId,
    baseRelevantRowsHash: input.backupBase.relevant_rows_hash,
    applicationRelevantRowsHash: input.applicationRelevantRowsHash,
    currentRelevantRowsHash: input.currentBase.relevant_rows_hash,
    currentProjectRevision: input.currentBase.authority.revision,
    currentAuthorityEpoch: input.currentBase.authority.authority_epoch,
  });
  return deepFreeze({
    planSchemaVersion: LEGACY_IMPORT_FORWARD_REPAIR_PLAN_SCHEMA_VERSION,
    applicationOperationId: input.applicationOperationId,
    applicationIdentityHash: input.applicationIdentityHash,
    previewId: input.previewId,
    previewHash: input.previewHash,
    backupId: input.backupId,
    differenceHash,
    expectedProjectRevision: input.currentBase.authority.revision,
    expectedAuthorityEpoch: input.currentBase.authority.authority_epoch,
    baseRelevantRowsHash: input.backupBase.relevant_rows_hash,
    applicationRelevantRowsHash: input.applicationRelevantRowsHash,
    currentRelevantRowsHash: input.currentBase.relevant_rows_hash,
    targetCount: targets.length,
    mutationCount,
    preservedCount,
    rejectedCount,
    unresolvedCount,
    targets,
  });
}
