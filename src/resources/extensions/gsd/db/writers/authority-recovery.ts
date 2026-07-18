// Project/App: gsd-pi
// File Purpose: Context-bound writers for project authority and import recovery receipts.

import type {
  DomainOperationContext,
  ImportRestoreReceiptContract,
} from "../domain-operation.js";
import { getDb } from "../engine.js";
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
