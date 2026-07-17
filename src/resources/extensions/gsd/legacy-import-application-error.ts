// Project/App: gsd-pi
// File Purpose: Shared typed failure contract for legacy Import Application modules.

import type { LegacyImportValue } from "./legacy-import-contract.js";

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
