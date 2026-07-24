// Project/App: gsd-pi
// File Purpose: Executable characterization and immutable contract tests for Import Application.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  type LegacyImportValue,
} from "../legacy-import-contract.ts";
import { sealLegacyImportVerifiedBackup } from "../legacy-import-backup.ts";
import {
  LEGACY_IMPORT_APPLICATION_EVENT_TYPE,
  LEGACY_IMPORT_APPLICATION_OPERATION_TYPE,
  LegacyImportApplicationError,
  createLegacyImportApplicationIdentity,
} from "../legacy-import-application.ts";
import {
  LegacyImportApplicationError as InternalLegacyImportApplicationError,
} from "../legacy-import-application-error.ts";
import {
  hashLegacyImportValue,
  isValidLegacyImportPreviewArtifact,
  sealLegacyImportPreview,
  type LegacyImportPreviewSealInput,
} from "../legacy-import-preview.ts";

const EMPTY_HASH = hashLegacyImportValue([]);

function emptyPreview(): LegacyImportPreviewSealInput {
  return {
    import_kind: "legacy-markdown",
    importer_version: "1",
    base: {
      snapshot_schema_version: 1,
      database_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
      authority: {
        singleton: 1,
        project_id: "project-1",
        project_root_realpath: "/tmp/project-1",
        revision: 0,
        authority_epoch: 0,
        created_at: "2026-07-17T00:00:00.000Z",
        updated_at: "2026-07-17T00:00:00.000Z",
      },
      rows: [],
      relevant_rows_hash: EMPTY_HASH,
    },
    source_set_hash: EMPTY_HASH,
    change_set_hash: EMPTY_HASH,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  };
}

function unsupportedTargetPreview(
  target: { kind: string; key: string; field?: string },
): LegacyImportPreviewSealInput {
  const sourceId = hashLegacyImportValue("source-1");
  const source = {
    source_id: sourceId,
    path: ".gsd/STATE.md",
    kind: "markdown",
    byte_size: 4,
    sha256: hashLegacyImportValue("raw"),
    parser_id: "state",
    parser_version: "1",
    encoding: "utf-8" as const,
    outcome: "mapped" as const,
  };
  const change = {
    change_id: hashLegacyImportValue("change-1"),
    action: "create" as const,
    target,
    raw: {
      source_id: sourceId,
      locator: { start_byte: 0, end_byte: 4 },
      value: "raw",
      sha256: hashLegacyImportValue("raw"),
    },
    normalized: { invented: true },
    provenance: {
      source_id: sourceId,
      parser_id: source.parser_id,
      parser_version: source.parser_version,
    },
    reason_code: "characterize-unsupported-target",
  };
  return {
    ...emptyPreview(),
    source_set_hash: hashLegacyImportValue([source]),
    change_set_hash: hashLegacyImportValue([change]),
    counts: { create: 1, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources: [source],
    changes: [change],
    diagnoses: [],
    resolutions: [],
  };
}

test("import application contract: exposes one fixed operation and event identity", () => {
  assert.equal(LEGACY_IMPORT_APPLICATION_OPERATION_TYPE, "import.apply");
  assert.equal(LEGACY_IMPORT_APPLICATION_EVENT_TYPE, "legacy-import.applied");
});

test("import application contract: errors carry immutable safe failure facts", () => {
  const context: Record<string, LegacyImportValue> = {
    preview_hash: `sha256:${"1".repeat(64)}`,
    observed_target: "not-a-canonical-target",
    counts: { create: 1, unresolved: 0 },
  };
  const error = new LegacyImportApplicationError(
    "compile",
    "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED",
    "legacy import Preview contains an unsupported target",
    false,
    context,
  );
  context.observed_target = "mutated-after-construction";
  (context.counts as { create: number }).create = 99;

  assert.equal(error.name, "LegacyImportApplicationError");
  assert.equal(error.stage, "compile");
  assert.equal(error.code, "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED");
  assert.equal(error.retryable, false);
  assert.equal(error.context.observed_target, "not-a-canonical-target");
  assert.deepEqual(error.context.counts, { create: 1, unresolved: 0 });
  assert.equal(Object.isFrozen(error.context), true);
  assert.equal(Object.isFrozen(error.context.counts), true);
});

test("import application contract: public and internal errors share one runtime identity", () => {
  assert.equal(LegacyImportApplicationError, InternalLegacyImportApplicationError);
  const error = new InternalLegacyImportApplicationError(
    "compile",
    "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED",
    "legacy import Preview contains an unsupported target",
    false,
  );
  assert.ok(error instanceof LegacyImportApplicationError);
});

test("import application contract: structural Preview accepts unsupported semantic targets", () => {
  const unsupportedTargets = [
    { kind: "not-a-canonical-target", key: "row-1" },
    { kind: "milestone", key: "M001", field: "invented" },
  ];

  for (const target of unsupportedTargets) {
    const preview = sealLegacyImportPreview(unsupportedTargetPreview(target));
    assert.equal(isValidLegacyImportPreviewArtifact(preview), true);
    assert.deepEqual(preview.preview.changes[0]?.target, target);
  }
});

test("import application contract: Preview and backup IDs do not bind the complete backup", () => {
  const sealInput = emptyPreview();
  const preview = sealLegacyImportPreview(sealInput);
  const first = sealLegacyImportVerifiedBackup({
    preview,
    base: sealInput.base,
    backup_ref: "/tmp/first.sqlite",
    backup_sha256: `sha256:${"2".repeat(64)}`,
    backup_byte_size: 100,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: "2026-07-17T00:00:00.000Z",
  });
  const contentChanged = sealLegacyImportVerifiedBackup({
    preview,
    base: sealInput.base,
    backup_ref: "/tmp/changed.sqlite",
    backup_sha256: `sha256:${"3".repeat(64)}`,
    backup_byte_size: 101,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: "2026-07-17T00:01:00.000Z",
  });
  const relocated = sealLegacyImportVerifiedBackup({
    preview,
    base: sealInput.base,
    backup_ref: "/tmp/relocated.sqlite",
    backup_sha256: first.backup_sha256,
    backup_byte_size: first.backup_byte_size,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: "2026-07-17T00:02:00.000Z",
  });

  assert.equal(first.preview_hash, contentChanged.preview_hash);
  assert.notEqual(first.backup_id, contentChanged.backup_id);
  assert.equal(first.backup_id, relocated.backup_id);
  assert.notDeepEqual(first, relocated);
});

test("import application contract: replay identity has one canonical detached hash tuple", () => {
  const sealInput = emptyPreview();
  const preview = sealLegacyImportPreview(sealInput);
  const backup = sealLegacyImportVerifiedBackup({
    preview,
    base: sealInput.base,
    backup_ref: "/tmp/verified.sqlite",
    backup_sha256: `sha256:${"4".repeat(64)}`,
    backup_byte_size: 200,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: "2026-07-17T00:03:00.000Z",
  });
  const previewInput = {
    roots: [
      {
        id: "project",
        kind: "project" as const,
        physical_path: "/tmp/project",
        logical_path: ".gsd",
        presence: "required" as const,
      },
      {
        id: "external",
        kind: "external" as const,
        physical_path: "/tmp/external",
        logical_path: "external",
        presence: "optional" as const,
      },
    ],
    bundledDefinitionNames: ["review", "bugfix", "review"],
  };
  const application = createLegacyImportApplicationIdentity({
    invocation: {
      idempotencyKey: "import/apply/preview-1",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "developer",
    },
    previewInput,
    preview,
    backup,
  });
  const reordered = createLegacyImportApplicationIdentity({
    invocation: {
      idempotencyKey: "import/apply/preview-1",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "developer",
    },
    previewInput: {
      roots: [...previewInput.roots].reverse(),
      bundledDefinitionNames: ["bugfix", "review"],
    },
    preview,
    backup,
  });
  const expectedPreviewInputHash = hashLegacyImportValue({
    roots: [previewInput.roots[1], previewInput.roots[0]],
    bundledDefinitionNames: ["bugfix", "review"],
  });
  const expectedIdentity = {
    replayIdentitySchemaVersion: 1,
    invocation: {
      idempotencyKey: "import/apply/preview-1",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "developer",
      traceId: null,
      turnId: null,
    },
    previewInputHash: expectedPreviewInputHash,
    previewId: preview.preview.preview_id,
    previewHash: preview.preview_hash,
    backup,
  };

  previewInput.bundledDefinitionNames[0] = "mutated";
  assert.deepEqual(application.replayIdentity, expectedIdentity);
  assert.equal(application.applicationIdentityHash, hashLegacyImportValue(expectedIdentity));
  assert.deepEqual(reordered, application);
  assert.equal(Object.isFrozen(application), true);
  assert.equal(Object.isFrozen(application.replayIdentity), true);
  assert.equal(Object.isFrozen(application.replayIdentity.backup), true);
  assert.equal(Object.isFrozen(application.replayIdentity.backup.source_fingerprints), true);
});

test("import application contract: replay identity rejects invalid or mismatched input", () => {
  const sealInput = emptyPreview();
  const preview = sealLegacyImportPreview(sealInput);
  const backup = sealLegacyImportVerifiedBackup({
    preview,
    base: sealInput.base,
    backup_ref: "/tmp/verified.sqlite",
    backup_sha256: `sha256:${"5".repeat(64)}`,
    backup_byte_size: 300,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: "2026-07-17T00:04:00.000Z",
  });
  const valid = {
    invocation: {
      idempotencyKey: "import/apply/preview-2",
      sourceTransport: "internal",
      actorType: "agent",
    },
    previewInput: {
      roots: [{
        id: "project",
        kind: "project",
        physical_path: "/tmp/project",
        logical_path: ".gsd",
        presence: "required",
      }],
    },
    preview,
    backup,
  };
  const accessorInput = { ...valid };
  Object.defineProperty(accessorInput, "backup", {
    enumerable: true,
    get: () => backup,
  });
  const symbolInput = { ...valid, [Symbol("hidden")]: true };
  const truncatedBackup = structuredClone(backup) as unknown as Record<string, unknown>;
  delete truncatedBackup["backup_sha256"];
  let nestedAccessorReads = 0;
  const nestedAccessorInvocation = { ...valid.invocation };
  Object.defineProperty(nestedAccessorInvocation, "actorType", {
    enumerable: true,
    get: () => {
      nestedAccessorReads += 1;
      return "agent";
    },
  });

  for (const invalid of [
    { ...valid, unexpected: true },
    accessorInput,
    symbolInput,
    { ...valid, invocation: nestedAccessorInvocation },
    { ...valid, invocation: { ...valid.invocation, idempotencyKey: "" } },
    { ...valid, previewInput: { ...valid.previewInput, bundledDefinitionNames: ["ok", ""] } },
    { ...valid, previewInput: { ...valid.previewInput, bundledDefinitionNames: Array(1) } },
    { ...valid, backup: truncatedBackup },
    { ...valid, backup: { ...backup, preview_hash: `sha256:${"0".repeat(64)}` } },
  ]) {
    assert.throws(
      () => createLegacyImportApplicationIdentity(invalid),
      (error: unknown) => {
        assert.equal((error as LegacyImportApplicationError).stage, "contract");
        assert.equal(
          (error as LegacyImportApplicationError).code,
          "LEGACY_IMPORT_APPLICATION_CONTRACT_INVALID",
        );
        return true;
      },
    );
  }
  assert.equal(nestedAccessorReads, 0);
});
