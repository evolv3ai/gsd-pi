// Project/App: gsd-pi
// File Purpose: Public v1 contract for explicit transactional legacy Import Application.

import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  isValidLegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackup,
} from "./legacy-import-backup.js";
import type { LegacyImportSha256, LegacyImportValue } from "./legacy-import-contract.js";
import {
  hashLegacyImportValue,
  isStrictLegacyImportData,
  isValidLegacyImportPreviewArtifact,
  type LegacyImportPreviewArtifact,
  type LegacyImportPreviewCreateInput,
} from "./legacy-import-preview.js";
import {
  validateLegacyImportSourceRoots,
  type LegacyImportSourceRoot,
} from "./legacy-import-preview-source.js";

export const LEGACY_IMPORT_APPLICATION_OPERATION_TYPE = "import.apply" as const;
export const LEGACY_IMPORT_APPLICATION_EVENT_TYPE = "legacy-import.applied" as const;
export const LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION = 1 as const;

export interface LegacyImportApplicationInput {
  readonly invocation: Readonly<ExecutionInvocation>;
  readonly previewInput: Readonly<LegacyImportPreviewCreateInput>;
  readonly preview: Readonly<LegacyImportPreviewArtifact>;
  readonly backup: Readonly<LegacyImportVerifiedBackup>;
}

export interface LegacyImportApplicationInvocationIdentity {
  readonly idempotencyKey: string;
  readonly sourceTransport: ExecutionInvocation["sourceTransport"];
  readonly actorType: string;
  readonly actorId: string | null;
  readonly traceId: string | null;
  readonly turnId: string | null;
}

export interface LegacyImportApplicationReplayIdentity {
  readonly replayIdentitySchemaVersion:
    typeof LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION;
  readonly invocation: Readonly<LegacyImportApplicationInvocationIdentity>;
  readonly previewInputHash: LegacyImportSha256;
  readonly previewId: string;
  readonly previewHash: LegacyImportSha256;
  readonly backup: Readonly<LegacyImportVerifiedBackup>;
}

export interface LegacyImportApplicationIdentity {
  readonly replayIdentity: Readonly<LegacyImportApplicationReplayIdentity>;
  readonly applicationIdentityHash: LegacyImportSha256;
}

export interface LegacyImportApplicationReceipt {
  readonly status: "committed" | "replayed";
  readonly operationId: string;
  readonly projectId: string;
  readonly applicationIdentityHash: LegacyImportSha256;
  readonly previewId: string;
  readonly previewHash: LegacyImportSha256;
  readonly backupId: LegacyImportSha256;
  readonly baseProjectRevision: number;
  readonly baseAuthorityEpoch: number;
  readonly resultingRevision: number;
  readonly resultingAuthorityEpoch: number;
  readonly appliedAt: string;
  readonly eventIds: readonly string[];
  readonly outboxIds: readonly number[];
  readonly projectionWorkIds: readonly string[];
}

export type LegacyImportApplicationErrorStage =
  | "contract"
  | "replay"
  | "preview"
  | "backup"
  | "compile"
  | "coordination"
  | "transaction"
  | "receipt";

export type LegacyImportApplicationErrorCode =
  | "LEGACY_IMPORT_APPLICATION_CONTRACT_INVALID"
  | "LEGACY_IMPORT_APPLICATION_REPLAY_CONFLICT"
  | "LEGACY_IMPORT_APPLICATION_PREVIEW_INVALID"
  | "LEGACY_IMPORT_APPLICATION_PREVIEW_UNRESOLVED"
  | "LEGACY_IMPORT_APPLICATION_PREVIEW_CHANGED"
  | "LEGACY_IMPORT_APPLICATION_BACKUP_INVALID"
  | "LEGACY_IMPORT_APPLICATION_BACKUP_CHANGED"
  | "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED"
  | "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT"
  | "LEGACY_IMPORT_APPLICATION_COORDINATION_ACTIVE"
  | "LEGACY_IMPORT_APPLICATION_AUTHORITY_STALE"
  | "LEGACY_IMPORT_APPLICATION_WRITER_CONTENTION"
  | "LEGACY_IMPORT_APPLICATION_MUTATION_FAILED"
  | "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT";

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export class LegacyImportApplicationError extends Error {
  readonly stage: LegacyImportApplicationErrorStage;
  readonly code: LegacyImportApplicationErrorCode;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, LegacyImportValue>>;

  constructor(
    stage: LegacyImportApplicationErrorStage,
    code: LegacyImportApplicationErrorCode,
    message: string,
    retryable: boolean,
    context: Readonly<Record<string, LegacyImportValue>> = {},
  ) {
    super(message);
    this.name = "LegacyImportApplicationError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.context = deepFreeze(structuredClone(context));
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => (
      (required.includes(key) || optional.includes(key))
      && Object.hasOwn(descriptors[key] ?? {}, "value")
      && descriptors[key]?.enumerable === true
    ));
}

function failContract(message: string): never {
  throw new LegacyImportApplicationError(
    "contract",
    "LEGACY_IMPORT_APPLICATION_CONTRACT_INVALID",
    message,
    false,
  );
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failContract(`${field} must be non-blank text`);
  }
  return value;
}

function normalizeInvocation(value: unknown): LegacyImportApplicationInvocationIdentity {
  if (!hasExactKeys(
    value,
    ["idempotencyKey", "sourceTransport", "actorType"],
    ["actorId", "traceId", "turnId"],
  )) {
    failContract("legacy import Application invocation does not satisfy the exact v1 contract");
  }
  const invocation = value;
  const sourceTransport = invocation["sourceTransport"];
  if (!(sourceTransport === "internal" || sourceTransport === "pi-tool" || sourceTransport === "workflow-mcp")) {
    failContract("legacy import Application source transport is invalid");
  }
  function optionalIdentity(field: "actorId" | "traceId" | "turnId"): string | null {
    const candidate = invocation[field];
    return candidate === undefined ? null : requireNonBlank(candidate, `invocation.${field}`);
  }
  return {
    idempotencyKey: requireNonBlank(invocation["idempotencyKey"], "invocation.idempotencyKey"),
    sourceTransport,
    actorType: requireNonBlank(invocation["actorType"], "invocation.actorType"),
    actorId: optionalIdentity("actorId"),
    traceId: optionalIdentity("traceId"),
    turnId: optionalIdentity("turnId"),
  };
}

function normalizeBundledDefinitionNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!hasExactArrayDataProperties(value)) {
    failContract("previewInput.bundledDefinitionNames must be an array");
  }
  const names = Array.from(value, (entry, index) => (
    requireNonBlank(entry, `previewInput.bundledDefinitionNames[${index}]`)
  ));
  return [...new Set(names)].sort();
}

function hasExactArrayDataProperties(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) return false;
  if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, "length") ?? {}, "value")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(index)) ?? {}, "value")) {
      return false;
    }
  }
  return true;
}

function normalizePreviewInput(value: unknown): {
  roots: LegacyImportSourceRoot[];
  bundledDefinitionNames: string[];
} {
  if (!hasExactKeys(value, ["roots"], ["bundledDefinitionNames"])) {
    failContract("legacy import Preview input does not satisfy the exact v1 contract");
  }
  let roots: LegacyImportSourceRoot[];
  try {
    roots = validateLegacyImportSourceRoots(value["roots"]);
  } catch {
    failContract("legacy import Preview roots do not satisfy the exact v1 contract");
  }
  return {
    roots,
    bundledDefinitionNames: normalizeBundledDefinitionNames(value["bundledDefinitionNames"]),
  };
}

function requireBackupLinkage(
  value: unknown,
  preview: LegacyImportPreviewArtifact,
): asserts value is LegacyImportVerifiedBackup {
  if (!isValidLegacyImportVerifiedBackup(value)) {
    failContract("verified backup does not satisfy the complete self-identical v1 contract");
  }
  if (
    value["preview_id"] !== preview.preview.preview_id
    || value["preview_hash"] !== preview.preview_hash
  ) {
    failContract("verified backup does not match the sealed Preview identity");
  }
}

export function createLegacyImportApplicationIdentity(
  value: unknown,
): LegacyImportApplicationIdentity {
  if (!hasExactKeys(value, ["invocation", "previewInput", "preview", "backup"])) {
    failContract("legacy import Application input does not satisfy the exact v1 contract");
  }
  if (!isStrictLegacyImportData(value)) {
    failContract("legacy import Application input must contain acyclic strict data properties");
  }
  let input: Record<string, unknown>;
  try {
    input = structuredClone(value);
  } catch {
    failContract("legacy import Application input must be detached strict data");
  }
  if (!isValidLegacyImportPreviewArtifact(input["preview"])) {
    failContract("legacy import Application Preview does not satisfy the sealed v1 contract");
  }
  const preview = input["preview"];
  const normalizedPreviewInput = normalizePreviewInput(input["previewInput"]);
  requireBackupLinkage(input["backup"], preview);
  const replayIdentity: LegacyImportApplicationReplayIdentity = {
    replayIdentitySchemaVersion: LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION,
    invocation: normalizeInvocation(input["invocation"]),
    previewInputHash: hashLegacyImportValue(normalizedPreviewInput),
    previewId: preview.preview.preview_id,
    previewHash: preview.preview_hash,
    backup: input["backup"],
  };
  return deepFreeze({
    replayIdentity,
    applicationIdentityHash: hashLegacyImportValue(replayIdentity),
  });
}
