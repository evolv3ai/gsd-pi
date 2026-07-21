// Project/App: gsd-pi
// File Purpose: Additive v45 receipts for authority cutover and import recovery.

import type { DbAdapter } from "./db-adapter.js";

export function createAuthorityRecoverySchemaV45(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_authority_cutovers (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      authority_contract_version INTEGER NOT NULL CHECK (authority_contract_version > 0),
      evidence_hash TEXT NOT NULL CHECK (
        length(evidence_hash) = 71 AND substr(evidence_hash, 1, 7) = 'sha256:' AND
        evidence_hash = lower(evidence_hash) AND
        substr(evidence_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      consent_hash TEXT NOT NULL CHECK (
        length(consent_hash) = 71 AND substr(consent_hash, 1, 7) = 'sha256:' AND
        consent_hash = lower(consent_hash) AND
        substr(consent_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      cutover_at TEXT NOT NULL CHECK (length(trim(cutover_at)) > 0),
      resulting_project_revision INTEGER NOT NULL CHECK (resulting_project_revision > 0),
      resulting_authority_epoch INTEGER NOT NULL CHECK (resulting_authority_epoch > 0),
      UNIQUE (project_id, resulting_authority_epoch),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (
        operation_id, project_id, resulting_project_revision, resulting_authority_epoch
      ) REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_authority_cutover_causality
    BEFORE INSERT ON workflow_authority_cutovers
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_operations operation
      WHERE operation.operation_id = NEW.operation_id
        AND operation.project_id = NEW.project_id
        AND operation.operation_type = 'authority.cutover'
        AND operation.resulting_revision = NEW.resulting_project_revision
        AND operation.expected_revision = NEW.resulting_project_revision - 1
        AND operation.resulting_authority_epoch = NEW.resulting_authority_epoch
        AND operation.expected_authority_epoch = NEW.resulting_authority_epoch - 1
        AND operation.created_at = NEW.cutover_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'authority cutover must match its advancing operation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_authority_cutover_update
    BEFORE UPDATE ON workflow_authority_cutovers
    BEGIN
      SELECT RAISE(ABORT, 'authority cutovers are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_authority_cutover_delete
    BEFORE DELETE ON workflow_authority_cutovers
    BEGIN
      SELECT RAISE(ABORT, 'authority cutovers are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_import_restores (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      application_operation_id TEXT NOT NULL CHECK (application_operation_id != operation_id),
      application_identity_hash TEXT NOT NULL CHECK (
        length(application_identity_hash) = 71 AND
        substr(application_identity_hash, 1, 7) = 'sha256:' AND
        application_identity_hash = lower(application_identity_hash) AND
        substr(application_identity_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      application_resulting_project_revision INTEGER NOT NULL CHECK (
        application_resulting_project_revision > 0
      ),
      application_resulting_authority_epoch INTEGER NOT NULL CHECK (
        application_resulting_authority_epoch >= 0
      ),
      erased_lineage_hash TEXT NOT NULL CHECK (
        length(erased_lineage_hash) = 71 AND
        substr(erased_lineage_hash, 1, 7) = 'sha256:' AND
        erased_lineage_hash = lower(erased_lineage_hash) AND
        substr(erased_lineage_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      erased_lineage_json TEXT NOT NULL CHECK (
        json_valid(erased_lineage_json) AND
        json_type(erased_lineage_json) = 'object' AND
        json_extract(erased_lineage_json, '$.schemaVersion') IS 1 AND
        json_extract(erased_lineage_json, '$.applicationOperationId')
          IS application_operation_id AND
        json_extract(erased_lineage_json, '$.applicationIdentityHash')
          IS application_identity_hash AND
        json_extract(erased_lineage_json, '$.applicationResultingProjectRevision')
          IS application_resulting_project_revision AND
        json_extract(erased_lineage_json, '$.applicationResultingAuthorityEpoch')
          IS application_resulting_authority_epoch
      ),
      preview_id TEXT NOT NULL CHECK (length(trim(preview_id)) > 0),
      preview_hash TEXT NOT NULL CHECK (
        length(preview_hash) = 71 AND substr(preview_hash, 1, 7) = 'sha256:' AND
        preview_hash = lower(preview_hash) AND
        substr(preview_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      backup_id TEXT NOT NULL CHECK (
        length(backup_id) = 71 AND substr(backup_id, 1, 7) = 'sha256:' AND
        backup_id = lower(backup_id) AND substr(backup_id, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      backup_sha256 TEXT NOT NULL CHECK (
        length(backup_sha256) = 71 AND substr(backup_sha256, 1, 7) = 'sha256:' AND
        backup_sha256 = lower(backup_sha256) AND
        substr(backup_sha256, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      backup_byte_size INTEGER NOT NULL CHECK (backup_byte_size > 0),
      backup_schema_version INTEGER NOT NULL CHECK (backup_schema_version > 0),
      backup_project_revision INTEGER NOT NULL CHECK (backup_project_revision >= 0),
      backup_authority_epoch INTEGER NOT NULL CHECK (backup_authority_epoch >= 0),
      difference_hash TEXT NOT NULL CHECK (
        length(difference_hash) = 71 AND substr(difference_hash, 1, 7) = 'sha256:' AND
        difference_hash = lower(difference_hash) AND
        substr(difference_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      consent_hash TEXT NOT NULL CHECK (
        length(consent_hash) = 71 AND substr(consent_hash, 1, 7) = 'sha256:' AND
        consent_hash = lower(consent_hash) AND
        substr(consent_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      verification_hash TEXT NOT NULL CHECK (
        length(verification_hash) = 71 AND
        substr(verification_hash, 1, 7) = 'sha256:' AND
        verification_hash = lower(verification_hash) AND
        substr(verification_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      restored_at TEXT NOT NULL CHECK (length(trim(restored_at)) > 0),
      resulting_project_revision INTEGER NOT NULL CHECK (
        resulting_project_revision = backup_project_revision + 1
      ),
      resulting_authority_epoch INTEGER NOT NULL CHECK (
        resulting_authority_epoch = backup_authority_epoch
      ),
      UNIQUE (project_id, application_operation_id),
      UNIQUE (project_id, application_identity_hash),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (
        operation_id, project_id, resulting_project_revision, resulting_authority_epoch
      ) REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      ),
      CHECK (application_resulting_project_revision = backup_project_revision + 1),
      CHECK (application_resulting_authority_epoch = backup_authority_epoch)
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_restore_causality
    BEFORE INSERT ON workflow_import_restores
    WHEN EXISTS (
      SELECT 1 FROM workflow_operations erased
      WHERE erased.operation_id = NEW.application_operation_id
    ) OR EXISTS (
      SELECT 1 FROM workflow_import_applications erased
      WHERE erased.operation_id = NEW.application_operation_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM workflow_operations operation
      WHERE operation.operation_id = NEW.operation_id
        AND operation.project_id = NEW.project_id
        AND operation.operation_type = 'import.restore'
        AND operation.expected_revision = NEW.backup_project_revision
        AND operation.resulting_revision = NEW.resulting_project_revision
        AND operation.expected_authority_epoch = NEW.backup_authority_epoch
        AND operation.resulting_authority_epoch = NEW.resulting_authority_epoch
        AND operation.created_at = NEW.restored_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'import restore must replace erased Application lineage');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_restore_update
    BEFORE UPDATE ON workflow_import_restores
    BEGIN
      SELECT RAISE(ABORT, 'import restores are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_restore_delete
    BEFORE DELETE ON workflow_import_restores
    BEGIN
      SELECT RAISE(ABORT, 'import restores are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_import_forward_repairs (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      application_operation_id TEXT NOT NULL,
      application_identity_hash TEXT NOT NULL CHECK (
        length(application_identity_hash) = 71 AND
        substr(application_identity_hash, 1, 7) = 'sha256:' AND
        application_identity_hash = lower(application_identity_hash) AND
        substr(application_identity_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      preview_id TEXT NOT NULL CHECK (length(trim(preview_id)) > 0),
      preview_hash TEXT NOT NULL CHECK (
        length(preview_hash) = 71 AND substr(preview_hash, 1, 7) = 'sha256:' AND
        preview_hash = lower(preview_hash) AND
        substr(preview_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      backup_id TEXT NOT NULL CHECK (
        length(backup_id) = 71 AND substr(backup_id, 1, 7) = 'sha256:' AND
        backup_id = lower(backup_id) AND substr(backup_id, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      difference_hash TEXT NOT NULL CHECK (
        length(difference_hash) = 71 AND substr(difference_hash, 1, 7) = 'sha256:' AND
        difference_hash = lower(difference_hash) AND
        substr(difference_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      plan_schema_version INTEGER NOT NULL CHECK (plan_schema_version > 0),
      plan_hash TEXT NOT NULL UNIQUE CHECK (
        length(plan_hash) = 71 AND substr(plan_hash, 1, 7) = 'sha256:' AND
        plan_hash = lower(plan_hash) AND substr(plan_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      plan_json TEXT NOT NULL CHECK (
        json_valid(plan_json) AND json_type(plan_json) = 'object' AND
        json_extract(plan_json, '$.planSchemaVersion') IS plan_schema_version AND
        json_extract(plan_json, '$.applicationOperationId') IS application_operation_id AND
        json_extract(plan_json, '$.applicationIdentityHash') IS application_identity_hash AND
        json_extract(plan_json, '$.previewId') IS preview_id AND
        json_extract(plan_json, '$.previewHash') IS preview_hash AND
        json_extract(plan_json, '$.backupId') IS backup_id AND
        json_extract(plan_json, '$.differenceHash') IS difference_hash AND
        json_extract(plan_json, '$.targetCount') IS target_count AND
        json_extract(plan_json, '$.mutationCount') IS mutation_count AND
        json_extract(plan_json, '$.preservedCount') IS preserved_count AND
        json_extract(plan_json, '$.rejectedCount') IS rejected_count AND
        json_extract(plan_json, '$.unresolvedCount') IS unresolved_count
      ),
      target_count INTEGER NOT NULL CHECK (target_count >= 0),
      mutation_count INTEGER NOT NULL CHECK (mutation_count >= 0),
      preserved_count INTEGER NOT NULL CHECK (preserved_count >= 0),
      rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
      unresolved_count INTEGER NOT NULL CHECK (unresolved_count = 0),
      repaired_at TEXT NOT NULL CHECK (length(trim(repaired_at)) > 0),
      resulting_project_revision INTEGER NOT NULL CHECK (resulting_project_revision > 0),
      resulting_authority_epoch INTEGER NOT NULL CHECK (resulting_authority_epoch >= 0),
      UNIQUE (project_id, application_operation_id),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (application_operation_id)
        REFERENCES workflow_import_applications(operation_id),
      FOREIGN KEY (
        operation_id, project_id, resulting_project_revision, resulting_authority_epoch
      ) REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      ),
      CHECK (target_count = mutation_count + preserved_count + rejected_count)
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_forward_repair_causality
    BEFORE INSERT ON workflow_import_forward_repairs
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_operations operation
      JOIN workflow_import_applications application
        ON application.operation_id = NEW.application_operation_id
      JOIN workflow_domain_events application_event
        ON application_event.operation_id = application.operation_id
       AND application_event.event_index = 0
       AND application_event.event_type = 'legacy-import.applied'
      WHERE operation.operation_id = NEW.operation_id
        AND operation.project_id = NEW.project_id
        AND operation.operation_type = 'import.forward_repair'
        AND operation.expected_revision = NEW.resulting_project_revision - 1
        AND operation.resulting_revision = NEW.resulting_project_revision
        AND operation.expected_authority_epoch = NEW.resulting_authority_epoch
        AND operation.resulting_authority_epoch = NEW.resulting_authority_epoch
        AND operation.created_at = NEW.repaired_at
        AND application.project_id = NEW.project_id
        AND application.preview_id = NEW.preview_id
        AND application.preview_hash = NEW.preview_hash
        AND application.resulting_project_revision <= operation.expected_revision
        AND application.resulting_authority_epoch <= operation.expected_authority_epoch
        AND application_event.project_id = application.project_id
        AND application_event.project_revision = application.resulting_project_revision
        AND application_event.authority_epoch = application.resulting_authority_epoch
        AND application_event.entity_type = 'legacy-import'
        AND application_event.entity_id = application.preview_id
        AND application_event.caused_by_event_id IS NULL
        AND application_event.created_at = application.applied_at
        AND json_extract(application_event.payload_json, '$.applicationIdentityHash')
          IS NEW.application_identity_hash
        AND json_extract(application_event.payload_json, '$.backupId') IS NEW.backup_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'import Forward Repair must match its Application and operation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_forward_repair_update
    BEFORE UPDATE ON workflow_import_forward_repairs
    BEGIN
      SELECT RAISE(ABORT, 'import Forward Repairs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_import_forward_repair_delete
    BEFORE DELETE ON workflow_import_forward_repairs
    BEGIN
      SELECT RAISE(ABORT, 'import Forward Repairs are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_authority_recovery_operation_update
    BEFORE UPDATE ON workflow_operations
    WHEN EXISTS (
      SELECT 1 FROM workflow_authority_cutovers receipt
      WHERE receipt.operation_id = OLD.operation_id
    ) OR EXISTS (
      SELECT 1 FROM workflow_import_restores receipt
      WHERE receipt.operation_id = OLD.operation_id
    ) OR EXISTS (
      SELECT 1 FROM workflow_import_forward_repairs receipt
      WHERE receipt.operation_id = OLD.operation_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'authority recovery operations are immutable');
    END;
  `);

  db.exec("DROP TRIGGER IF EXISTS trg_workflow_lifecycle_transition");
  db.exec(`
    CREATE TRIGGER trg_workflow_lifecycle_transition
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN NOT (
        NEW.lifecycle_status != OLD.lifecycle_status
        AND (
          NEW.last_project_revision <= OLD.last_project_revision
          OR NEW.last_authority_epoch < OLD.last_authority_epoch
        )
      )
      AND (
        NEW.lifecycle_status = OLD.lifecycle_status
        OR NEW.state_version != OLD.state_version + 1
        OR NEW.updated_at = OLD.updated_at
        OR NOT (
          (OLD.lifecycle_status = 'pending' AND NEW.lifecycle_status IN ('ready', 'cancelled'))
          OR (OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status IN ('in_progress', 'paused', 'cancelled'))
          OR (OLD.item_kind = 'slice' AND OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status = 'completed')
          OR (
            OLD.item_kind = 'milestone'
            AND OLD.lifecycle_status IN ('ready', 'in_progress')
            AND NEW.lifecycle_status = 'completed'
            AND EXISTS (
              SELECT 1
              FROM workflow_operations operation
              WHERE operation.operation_id = NEW.last_operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'milestone.complete'
                AND operation.resulting_revision = NEW.last_project_revision
                AND operation.resulting_authority_epoch = NEW.last_authority_epoch
            )
          )
          OR (
            OLD.lifecycle_status = 'in_progress'
            AND NEW.lifecycle_status IN ('paused', 'completed', 'cancelled')
            AND NOT (OLD.item_kind = 'milestone' AND NEW.lifecycle_status = 'completed')
          )
          OR (OLD.lifecycle_status = 'paused' AND NEW.lifecycle_status IN ('ready', 'in_progress', 'cancelled'))
          OR (OLD.lifecycle_status IN ('completed', 'cancelled') AND NEW.lifecycle_status = 'ready')
          OR (
            OLD.lifecycle_status = 'completed'
            AND NEW.lifecycle_status = 'cancelled'
            AND EXISTS (
              SELECT 1
              FROM workflow_operations operation
              WHERE operation.operation_id = NEW.last_operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'import.forward_repair'
                AND operation.resulting_revision = NEW.last_project_revision
                AND operation.resulting_authority_epoch = NEW.last_authority_epoch
            )
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle transition');
    END
  `);
}
