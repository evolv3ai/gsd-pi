// Project/App: gsd-pi
// File Purpose: Context-bound writers for project authority and import recovery receipts.

import type {
  DomainOperationContext,
  ImportRestoreReceiptContract,
} from "../domain-operation.js";
import { getDb } from "../engine.js";
import type { LegacyImportValue } from "../../legacy-import-contract.js";
import type {
  LegacyImportForwardRepairMutation,
  LegacyImportForwardRepairPlan,
} from "../../legacy-import-forward-repair-plan.js";
import { LEGACY_IMPORT_TARGET_ADAPTERS } from "../../legacy-import-preview-classifier-targets.js";
import { canonicalLegacyImportJson, hashLegacyImportValue } from "../../legacy-import-preview.js";
import { synthesizeDecisionMemoryContent } from "../../memory-backfill.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export interface AuthorityCutoverReceiptInput {
  readonly authorityContractVersion: number;
  readonly evidenceHash: string;
  readonly consentHash: string;
}

export interface AuthorityCutoverReceiptWriteResult {
  readonly cutoverAt: string;
}

export type ImportRestoreReceiptInput = ImportRestoreReceiptContract;

export interface ImportRestoreReceiptWriteResult {
  readonly restoredAt: string;
}

export interface ImportForwardRepairWriteResult {
  readonly repairedAt: string;
  readonly planHash: string;
}

export function insertAuthorityCutoverReceipt(
  context: Readonly<DomainOperationContext>,
  input: Readonly<AuthorityCutoverReceiptInput>,
): AuthorityCutoverReceiptWriteResult {
  if (requireActiveDomainOperationContext(context) !== "authority.cutover") {
    throw new Error("authority cutover receipt requires an active authority.cutover operation");
  }
  const operation = getDb().prepare(`
    SELECT expected_revision, expected_authority_epoch, created_at
    FROM workflow_operations
    WHERE operation_id = :operation_id AND project_id = :project_id
  `).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
  });
  const cutoverAt = operation?.["created_at"];
  if (
    operation?.["expected_revision"] !== context.resultingRevision - 1
    || operation?.["expected_authority_epoch"] !== context.resultingAuthorityEpoch - 1
    || typeof cutoverAt !== "string"
    || cutoverAt.trim().length === 0
  ) {
    throw new Error("authority cutover receipt context does not advance exact authority");
  }

  const result = getDb().prepare(`
    INSERT INTO workflow_authority_cutovers (
      operation_id, project_id, authority_contract_version,
      evidence_hash, consent_hash, cutover_at,
      resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      :operation_id, :project_id, :authority_contract_version,
      :evidence_hash, :consent_hash, :cutover_at,
      :resulting_project_revision, :resulting_authority_epoch
    )
  `).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":authority_contract_version": input.authorityContractVersion,
    ":evidence_hash": input.evidenceHash,
    ":consent_hash": input.consentHash,
    ":cutover_at": cutoverAt,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
  if ((result as { changes?: unknown }).changes !== 1) {
    throw new Error("authority cutover receipt was not inserted exactly once");
  }
  return Object.freeze({ cutoverAt });
}

export function insertImportRestoreReceipt(
  context: Readonly<DomainOperationContext>,
  input: Readonly<ImportRestoreReceiptInput>,
): ImportRestoreReceiptWriteResult {
  if (requireActiveDomainOperationContext(context) !== "import.restore") {
    throw new Error("import restore receipt requires an active import.restore operation");
  }
  const operation = getDb().prepare(`
    SELECT expected_revision, expected_authority_epoch, created_at
    FROM workflow_operations
    WHERE operation_id = :operation_id AND project_id = :project_id
  `).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
  });
  const restoredAt = operation?.["created_at"];
  if (
    operation?.["expected_revision"] !== input.backupProjectRevision
    || operation?.["expected_authority_epoch"] !== input.backupAuthorityEpoch
    || context.resultingRevision !== input.backupProjectRevision + 1
    || context.resultingAuthorityEpoch !== input.backupAuthorityEpoch
    || typeof restoredAt !== "string"
    || restoredAt.trim().length === 0
  ) {
    throw new Error("import restore receipt context does not match the restored backup authority");
  }

  const result = getDb().prepare(`
    INSERT INTO workflow_import_restores (
      operation_id, project_id,
      application_operation_id, application_identity_hash,
      application_resulting_project_revision, application_resulting_authority_epoch,
      erased_lineage_hash, erased_lineage_json,
      preview_id, preview_hash,
      backup_id, backup_sha256, backup_byte_size, backup_schema_version,
      backup_project_revision, backup_authority_epoch,
      difference_hash, consent_hash, verification_hash,
      restored_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      :operation_id, :project_id,
      :application_operation_id, :application_identity_hash,
      :application_resulting_project_revision, :application_resulting_authority_epoch,
      :erased_lineage_hash, :erased_lineage_json,
      :preview_id, :preview_hash,
      :backup_id, :backup_sha256, :backup_byte_size, :backup_schema_version,
      :backup_project_revision, :backup_authority_epoch,
      :difference_hash, :consent_hash, :verification_hash,
      :restored_at, :resulting_project_revision, :resulting_authority_epoch
    )
  `).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":application_operation_id": input.applicationOperationId,
    ":application_identity_hash": input.applicationIdentityHash,
    ":application_resulting_project_revision": input.applicationResultingProjectRevision,
    ":application_resulting_authority_epoch": input.applicationResultingAuthorityEpoch,
    ":erased_lineage_hash": input.erasedLineageHash,
    ":erased_lineage_json": input.erasedLineageJson,
    ":preview_id": input.previewId,
    ":preview_hash": input.previewHash,
    ":backup_id": input.backupId,
    ":backup_sha256": input.backupSha256,
    ":backup_byte_size": input.backupByteSize,
    ":backup_schema_version": input.backupSchemaVersion,
    ":backup_project_revision": input.backupProjectRevision,
    ":backup_authority_epoch": input.backupAuthorityEpoch,
    ":difference_hash": input.differenceHash,
    ":consent_hash": input.consentHash,
    ":verification_hash": input.verificationHash,
    ":restored_at": restoredAt,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
  if ((result as { changes?: unknown }).changes !== 1) {
    throw new Error("import restore receipt was not inserted exactly once");
  }
  return Object.freeze({ restoredAt });
}

type SqlRecord = Readonly<Record<string, null | number | string>>;

const FORWARD_REPAIR_TABLES = {
  milestones: "milestones",
  slices: "slices",
  tasks: "tasks",
  requirements: "requirements",
  artifacts: "artifacts",
  assessments: "assessments",
  decisions: "decisions",
} as const;

function changes(result: unknown): number {
  const value = (result as { changes?: unknown }).changes;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Forward Repair writer returned an invalid affected-row count");
  }
  return Number(value);
}

function sortedEntries(record: SqlRecord): Array<[string, null | number | string]> {
  return Object.entries(record).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function whereClause(record: SqlRecord, params: Record<string, unknown>): string {
  return sortedEntries(record).map(([field, value], index) => {
    const parameter = `:identity_${index}`;
    params[parameter] = value;
    return value === null ? `${field} IS NULL` : `${field} = ${parameter}`;
  }).join(" AND ");
}

function rowTable(mutation: Extract<LegacyImportForwardRepairMutation, {
  action: "create" | "update" | "delete";
}>): string {
  const adapter = Object.values(LEGACY_IMPORT_TARGET_ADAPTERS)
    .find((candidate) => candidate.rowSet === mutation.rowSet);
  const table = FORWARD_REPAIR_TABLES[mutation.rowSet as keyof typeof FORWARD_REPAIR_TABLES];
  if (!adapter || !table) throw new Error("Forward Repair row mutation has an unsupported target");
  const fields = [...Object.keys(mutation.identity), ...Object.keys(mutation.values)];
  if (fields.some((field) => !adapter.fields.has(field))) {
    throw new Error("Forward Repair row mutation has an unsupported field");
  }
  return table;
}

function applyRowMutation(mutation: Extract<LegacyImportForwardRepairMutation, {
  action: "create" | "update" | "delete";
}>): void {
  const table = rowTable(mutation);
  const params: Record<string, unknown> = {};
  let result: unknown;
  if (mutation.action === "create") {
    const values = sortedEntries(mutation.values);
    for (const [field, value] of values) params[`:${field}`] = value;
    result = getDb().prepare(`INSERT INTO ${table} (${values.map(([field]) => field).join(", ")})
      VALUES (${values.map(([field]) => `:${field}`).join(", ")})`).run(params);
  } else if (mutation.action === "update") {
    const values = sortedEntries(mutation.values);
    for (const [field, value] of values) params[`:${field}`] = value;
    result = getDb().prepare(`UPDATE ${table}
      SET ${values.map(([field]) => `${field} = :${field}`).join(", ")}
      WHERE ${whereClause(mutation.identity, params)}`).run(params);
  } else {
    result = getDb().prepare(`DELETE FROM ${table}
      WHERE ${whereClause(mutation.identity, params)}`).run(params);
  }
  if (changes(result) !== 1) throw new Error("Forward Repair row mutation must affect exactly one row");
}

function applyDependencyMutation(
  mutation: Extract<LegacyImportForwardRepairMutation, { action: "replace-slice-dependencies" }>,
): void {
  const params = { ":milestone_id": mutation.milestoneId, ":slice_id": mutation.sliceId };
  getDb().prepare(`DELETE FROM slice_dependencies
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id`).run(params);
  for (const dependency of mutation.dependsOnSliceIds) {
    const inserted = getDb().prepare(`INSERT INTO slice_dependencies
      (milestone_id, slice_id, depends_on_slice_id)
      VALUES (:milestone_id, :slice_id, :dependency)`).run({
      ...params,
      ":dependency": dependency,
    });
    if (changes(inserted) !== 1) throw new Error("Forward Repair dependency insertion was not exact");
  }
  const observed = getDb().prepare(`SELECT depends_on_slice_id FROM slice_dependencies
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id
    ORDER BY depends_on_slice_id`).all(params);
  if (canonicalLegacyImportJson(observed.map((row) => row["depends_on_slice_id"]) as LegacyImportValue)
    !== canonicalLegacyImportJson([...mutation.dependsOnSliceIds])) {
    throw new Error("Forward Repair dependency replacement was not exact");
  }
}

function decisionMemoryId(decisionId: string): string {
  const rows = getDb().prepare(`SELECT id FROM memories
    WHERE category = 'architecture'
      AND json_valid(structured_fields)
      AND json_extract(structured_fields, '$.sourceDecisionId') = :decision_id
    ORDER BY id`).all({ ":decision_id": decisionId });
  if (rows.length !== 1 || typeof rows[0]?.["id"] !== "string") {
    throw new Error("Forward Repair decision memory identity is not exact");
  }
  return String(rows[0]!["id"]);
}

function applyDecisionMutation(
  mutation: Extract<LegacyImportForwardRepairMutation, {
    action: "restore-decision-memory" | "delete-decision-memory";
  }>,
  repairedAt: string,
): void {
  const memoryId = decisionMemoryId(mutation.decisionId);
  if (mutation.action === "delete-decision-memory") {
    if (changes(getDb().prepare("DELETE FROM memories WHERE id = :id").run({ ":id": memoryId })) !== 1) {
      throw new Error("Forward Repair decision memory delete was not exact");
    }
    return;
  }
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(String(mutation.structuredFields)) as Record<string, unknown>;
  } catch {
    throw new Error("Forward Repair decision memory base is malformed");
  }
  const content = fields["deleted"] === true
    ? `Deleted decision ${mutation.decisionId}`
    : synthesizeDecisionMemoryContent({
        decision: String(fields["decision"] ?? ""),
        choice: String(fields["choice"] ?? ""),
        rationale: String(fields["rationale"] ?? ""),
      });
  const result = getDb().prepare(`UPDATE memories
    SET content = :content, scope = :scope,
        structured_fields = :structured_fields, updated_at = :updated_at
    WHERE id = :id`).run({
    ":content": content,
    ":scope": String(fields["scope"] ?? "project") || "project",
    ":structured_fields": mutation.structuredFields,
    ":updated_at": repairedAt,
    ":id": memoryId,
  });
  if (changes(result) !== 1) throw new Error("Forward Repair decision memory restore was not exact");
}

export function applyImportForwardRepairPlan(
  context: Readonly<DomainOperationContext>,
  plan: Readonly<LegacyImportForwardRepairPlan>,
): void {
  if (requireActiveDomainOperationContext(context) !== "import.forward_repair") {
    throw new Error("Forward Repair mutations require an active import.forward_repair operation");
  }
  const operation = getDb().prepare(`SELECT expected_revision, expected_authority_epoch, created_at
    FROM workflow_operations WHERE operation_id = :operation_id AND project_id = :project_id`).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
  });
  if (
    operation?.["expected_revision"] !== plan.expectedProjectRevision
    || operation?.["expected_authority_epoch"] !== plan.expectedAuthorityEpoch
    || context.resultingRevision !== plan.expectedProjectRevision + 1
    || context.resultingAuthorityEpoch !== plan.expectedAuthorityEpoch
    || typeof operation["created_at"] !== "string"
  ) throw new Error("Forward Repair authority fence does not match its plan");
  const repairedAt = String(operation["created_at"]);
  for (const entry of [...plan.targets].reverse()) {
    const mutation = entry.mutation;
    if (!mutation) continue;
    if ("rowSet" in mutation) {
      applyRowMutation(mutation);
    } else if (mutation.action === "replace-slice-dependencies") {
      applyDependencyMutation(mutation);
    } else {
      applyDecisionMutation(mutation, repairedAt);
    }
  }
}

export function insertImportForwardRepairReceipt(
  context: Readonly<DomainOperationContext>,
  plan: Readonly<LegacyImportForwardRepairPlan>,
): ImportForwardRepairWriteResult {
  if (requireActiveDomainOperationContext(context) !== "import.forward_repair") {
    throw new Error("Forward Repair receipt requires an active import.forward_repair operation");
  }
  if (plan.unresolvedCount !== 0) throw new Error("Forward Repair receipt cannot contain unresolved choices");
  const operation = getDb().prepare(`SELECT expected_revision, expected_authority_epoch, created_at
    FROM workflow_operations WHERE operation_id = :operation_id AND project_id = :project_id`).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
  });
  const repairedAt = operation?.["created_at"];
  if (
    operation?.["expected_revision"] !== plan.expectedProjectRevision
    || operation?.["expected_authority_epoch"] !== plan.expectedAuthorityEpoch
    || context.resultingRevision !== plan.expectedProjectRevision + 1
    || context.resultingAuthorityEpoch !== plan.expectedAuthorityEpoch
    || typeof repairedAt !== "string"
  ) throw new Error("Forward Repair receipt authority does not match its plan");
  const planJson = canonicalLegacyImportJson(plan as unknown as LegacyImportValue);
  const planHash = hashLegacyImportValue(plan as unknown as LegacyImportValue);
  const result = getDb().prepare(`INSERT INTO workflow_import_forward_repairs (
      operation_id, project_id, application_operation_id, application_identity_hash,
      preview_id, preview_hash, backup_id, difference_hash,
      plan_schema_version, plan_hash, plan_json,
      target_count, mutation_count, preserved_count, rejected_count, unresolved_count,
      repaired_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      :operation_id, :project_id, :application_operation_id, :application_identity_hash,
      :preview_id, :preview_hash, :backup_id, :difference_hash,
      :plan_schema_version, :plan_hash, :plan_json,
      :target_count, :mutation_count, :preserved_count, :rejected_count, :unresolved_count,
      :repaired_at, :resulting_project_revision, :resulting_authority_epoch
    )`).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":application_operation_id": plan.applicationOperationId,
    ":application_identity_hash": plan.applicationIdentityHash,
    ":preview_id": plan.previewId,
    ":preview_hash": plan.previewHash,
    ":backup_id": plan.backupId,
    ":difference_hash": plan.differenceHash,
    ":plan_schema_version": plan.planSchemaVersion,
    ":plan_hash": planHash,
    ":plan_json": planJson,
    ":target_count": plan.targetCount,
    ":mutation_count": plan.mutationCount,
    ":preserved_count": plan.preservedCount,
    ":rejected_count": plan.rejectedCount,
    ":unresolved_count": plan.unresolvedCount,
    ":repaired_at": repairedAt,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
  if (changes(result) !== 1) throw new Error("Forward Repair receipt was not inserted exactly once");
  return Object.freeze({ repairedAt, planHash });
}
