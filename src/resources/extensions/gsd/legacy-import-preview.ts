// Project/App: gsd-pi
// File Purpose: Pure canonical identity and sealing boundary for legacy import Preview artifacts.

import { createHash } from "node:crypto";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
  type LegacyImportPreviewChange,
  type LegacyImportPreviewCounts,
  type LegacyImportPreviewDiagnosis,
  type LegacyImportPreviewEnvelope,
  type LegacyImportPreviewResolution,
  type LegacyImportPreviewSource,
  type LegacyImportSha256,
} from "./legacy-import-contract.js";
import type { LegacyImportBaseSnapshot } from "./legacy-import-preview-base.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface LegacyImportPreviewArtifact {
  preview: LegacyImportPreviewEnvelope;
  preview_hash: LegacyImportSha256;
}

export interface LegacyImportPreviewSealInput {
  import_kind: string;
  importer_version: string;
  base: LegacyImportBaseSnapshot;
  source_set_hash: LegacyImportSha256;
  change_set_hash: LegacyImportSha256;
  counts: LegacyImportPreviewCounts;
  sources: readonly LegacyImportPreviewSource[];
  changes: readonly LegacyImportPreviewChange[];
  diagnoses: readonly LegacyImportPreviewDiagnosis[];
  resolutions: readonly LegacyImportPreviewResolution[];
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("legacy import identity requires strict JSON with finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("legacy import identity requires acyclic strict JSON");
    const keys = Object.keys(value);
    if (
      keys.length !== value.length
      || keys.some((key, index) => key !== String(index))
      || Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error("legacy import identity requires dense JSON arrays without extra keys");
    }
    ancestors.add(value);
    try {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") {
    throw new Error("legacy import identity requires strict JSON values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("legacy import identity requires plain JSON objects");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("legacy import identity requires strict JSON without symbol keys");
  }
  if (ancestors.has(value)) throw new Error("legacy import identity requires acyclic strict JSON");
  ancestors.add(value);
  try {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalLegacyImportJson(value: unknown): string {
  return canonicalJson(value, new Set());
}

export function hashLegacyImportBytes(value: string | Uint8Array): LegacyImportSha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashLegacyImportValue(value: unknown): LegacyImportSha256 {
  return hashLegacyImportBytes(canonicalLegacyImportJson(value));
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`);
}

function requireCanonicalKind(value: string): void {
  requireNonBlank(value, "import_kind");
  if (value !== value.trim().toLowerCase()) {
    throw new Error("import_kind must be trimmed lowercase text");
  }
}

function requireHash(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${field} must be a canonical SHA-256`);
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function validateCounts(input: LegacyImportPreviewSealInput): void {
  for (const [name, value] of Object.entries(input.counts)) {
    requireNonNegativeSafeInteger(value, `counts.${name}`);
  }
  const expected = {
    create: input.changes.filter((change) => change.action === "create").length,
    update: input.changes.filter((change) => change.action === "update").length,
    delete: input.changes.filter((change) => change.action === "delete").length,
    preserve: input.changes.filter((change) => change.action === "preserve").length,
    unparsed: input.sources.filter((source) => source.outcome === "unparsed").length,
    unresolved: input.resolutions.filter(
      (resolution) => resolution.disposition === "requires-user" || resolution.disposition === "unsupported",
    ).length,
  };
  if (canonicalLegacyImportJson(input.counts) !== canonicalLegacyImportJson(expected)) {
    throw new Error("legacy import Preview counts do not match evidence");
  }
}

function validateSealInput(input: LegacyImportPreviewSealInput): void {
  requireCanonicalKind(input.import_kind);
  requireNonBlank(input.importer_version, "importer_version");
  requireHash(input.source_set_hash, "source_set_hash");
  requireHash(input.change_set_hash, "change_set_hash");
  requireHash(input.base.relevant_rows_hash, "base.relevant_rows_hash");
  if (input.base.snapshot_schema_version !== 1) {
    throw new Error("legacy import base snapshot schema 1 is required");
  }
  if (input.base.database_schema_version !== LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION) {
    throw new Error(`legacy import database schema ${LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION} is required`);
  }
  requireNonBlank(input.base.authority.project_id, "base.authority.project_id");
  requireNonNegativeSafeInteger(input.base.authority.revision, "base.authority.revision");
  requireNonNegativeSafeInteger(input.base.authority.authority_epoch, "base.authority.authority_epoch");
  if (hashLegacyImportValue(input.base.rows) !== input.base.relevant_rows_hash) {
    throw new Error("base.relevant_rows_hash does not match base rows");
  }
  if (hashLegacyImportValue(input.sources) !== input.source_set_hash) {
    throw new Error("source_set_hash does not match Preview sources");
  }
  if (hashLegacyImportValue(input.changes) !== input.change_set_hash) {
    throw new Error("change_set_hash does not match Preview changes");
  }
  validateCounts(input);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/**
 * Derive a non-circular approval identity, then hash the complete exact v1
 * envelope. The base row hash catches relevant DB drift even if a broken
 * external writer failed to advance the authority revision.
 */
export function sealLegacyImportPreview(input: LegacyImportPreviewSealInput): LegacyImportPreviewArtifact {
  const sealedInput = structuredClone(input);
  validateSealInput(sealedInput);
  const previewId = hashLegacyImportValue({
    preview_schema_version: LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
    import_kind: sealedInput.import_kind,
    importer_version: sealedInput.importer_version,
    project_id: sealedInput.base.authority.project_id,
    project_root_realpath: sealedInput.base.authority.project_root_realpath,
    base_project_revision: sealedInput.base.authority.revision,
    base_authority_epoch: sealedInput.base.authority.authority_epoch,
    base_database_schema_version: sealedInput.base.database_schema_version,
    base_snapshot_schema_version: sealedInput.base.snapshot_schema_version,
    relevant_rows_hash: sealedInput.base.relevant_rows_hash,
    source_set_hash: sealedInput.source_set_hash,
    change_set_hash: sealedInput.change_set_hash,
  });
  const preview: LegacyImportPreviewEnvelope = {
    preview_schema_version: LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
    preview_id: previewId,
    import_kind: sealedInput.import_kind,
    importer_version: sealedInput.importer_version,
    base_project_revision: sealedInput.base.authority.revision,
    base_authority_epoch: sealedInput.base.authority.authority_epoch,
    base_database_schema_version: sealedInput.base.database_schema_version,
    source_set_hash: sealedInput.source_set_hash,
    change_set_hash: sealedInput.change_set_hash,
    counts: sealedInput.counts,
    sources: sealedInput.sources,
    changes: sealedInput.changes,
    diagnoses: sealedInput.diagnoses,
    resolutions: sealedInput.resolutions,
  };
  const previewHash = hashLegacyImportValue(preview);
  return deepFreeze({ preview, preview_hash: previewHash });
}
