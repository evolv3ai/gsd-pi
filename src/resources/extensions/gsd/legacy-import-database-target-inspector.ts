// Project/App: gsd-pi
// File Purpose: Ephemeral-copy SQLite inspection for retained legacy import database bytes.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DbAdapter } from "./db-adapter.js";
import type { LegacyImportSha256, LegacyImportValue } from "./legacy-import-contract.js";
import type {
  LegacyImportDatabaseTargetHeaderEvidence,
  LegacyImportDatabaseTargetInspectionEvidence,
  LegacyImportDatabaseTargetInspectionRequest,
  LegacyImportDatabaseTargetSchemaEvidence,
} from "./legacy-import-preview-database-target.js";
import type {
  LegacyImportGsdDatabaseEvidence,
  LegacyImportGsdDatabaseObservation,
} from "./legacy-import-preview-gsd.js";
import { hashLegacyImportBytes, hashLegacyImportValue } from "./legacy-import-preview.js";
import {
  configureSqliteReadOnly,
  openSqliteReadOnly,
  SqliteReadOnlyProviderUnavailableError,
  type SqliteReadOnlyConnection,
} from "./sqlite-readonly.js";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type LegacyImportDatabaseTargetInspectionErrorStage =
  | "materialize"
  | "provider"
  | "evidence"
  | "close"
  | "cleanup";

export class LegacyImportDatabaseTargetInspectionError extends Error {
  readonly stage: LegacyImportDatabaseTargetInspectionErrorStage;
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    stage: LegacyImportDatabaseTargetInspectionErrorStage,
    code: string,
    message: string,
    retryable: boolean,
    context: Record<string, string> = {},
  ) {
    super(message);
    this.name = "LegacyImportDatabaseTargetInspectionError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.context = Object.freeze({ ...context });
  }
}

export type LegacyImportDatabaseTargetInspectionConnection = SqliteReadOnlyConnection;

export interface LegacyImportDatabaseTargetInspectorDeps {
  makeTemporaryDirectory(): string;
  writePrivateFile(path: string, bytes: Buffer): void;
  readFile(path: string): Buffer;
  removeTemporaryDirectory(path: string): void;
  openReadOnly(path: string): LegacyImportDatabaseTargetInspectionConnection;
}

interface SchemaRow {
  type: string;
  name: string;
  table: string;
  sqlHash: LegacyImportSha256;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function requestContext(request: LegacyImportDatabaseTargetInspectionRequest): Record<string, string> {
  return { source_id: request.source_id, logical_path: request.logical_path };
}

function validateRequest(request: LegacyImportDatabaseTargetInspectionRequest): void {
  if (
    request.root_kind !== "project" && request.root_kind !== "external"
    || request.logical_path.length === 0
    || !SHA256_PATTERN.test(request.capture_hash)
    || !SHA256_PATTERN.test(request.source_id)
    || !SHA256_PATTERN.test(request.source_sha256)
    || !Number.isSafeInteger(request.source_byte_size)
    || request.source_byte_size < 0
    || request.bytes.length !== request.source_byte_size
    || hashLegacyImportBytes(request.bytes) !== request.source_sha256
  ) {
    throw new LegacyImportDatabaseTargetInspectionError(
      "materialize",
      "LEGACY_IMPORT_DATABASE_INSPECTION_REQUEST_INVALID",
      "legacy import database inspection request is inconsistent",
      false,
      requestContext(request),
    );
  }
}

function headerEvidence(bytes: Buffer): LegacyImportDatabaseTargetHeaderEvidence | undefined {
  if (bytes.length < 100 || !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) return undefined;
  const storedPageSize = bytes.readUInt16BE(16);
  const pageSize = storedPageSize === 1 ? 65_536 : storedPageSize;
  const validPageSize = pageSize === 65_536
    || (pageSize >= 512 && pageSize <= 32_768 && (pageSize & (pageSize - 1)) === 0);
  if (
    !validPageSize
    || bytes.length < pageSize
    || bytes.length % pageSize !== 0
    || !([1, 2] as const).includes(bytes[18] as 1 | 2)
    || !([1, 2] as const).includes(bytes[19] as 1 | 2)
    || bytes[21] !== 64
    || bytes[22] !== 32
    || bytes[23] !== 32
  ) return undefined;
  return { page_size: pageSize, write_version: bytes[18]!, read_version: bytes[19]! };
}

function failureFingerprint(
  request: LegacyImportDatabaseTargetInspectionRequest,
  reason: string,
): LegacyImportSha256 {
  return hashLegacyImportValue({ reason, source_sha256: request.source_sha256 });
}

function sealEvidence(
  request: LegacyImportDatabaseTargetInspectionRequest,
  inspection: LegacyImportDatabaseTargetInspectionEvidence["inspection"],
): LegacyImportDatabaseTargetInspectionEvidence {
  const value = {
    evidence_version: 1 as const,
    inspection_version: 1 as const,
    capture_hash: request.capture_hash,
    source_id: request.source_id,
    root_kind: request.root_kind,
    logical_path: request.logical_path,
    source_sha256: request.source_sha256,
    source_byte_size: request.source_byte_size,
    sidecars: [] as const,
    inspection,
  };
  return deepFreeze({ ...value, evidence_hash: hashLegacyImportValue(value) });
}

function rejectedEvidence(
  request: LegacyImportDatabaseTargetInspectionRequest,
  reason: "invalid-header" | "open-failed" | "quick-check-failed" | "non-gsd",
): LegacyImportDatabaseTargetInspectionEvidence {
  return sealEvidence(request, {
    kind: "rejected",
    reason,
    failure_fingerprint: failureFingerprint(request, reason),
  });
}

function defaultOpenReadOnly(path: string): LegacyImportDatabaseTargetInspectionConnection {
  try {
    return openSqliteReadOnly(path);
  } catch (error) {
    if (!(error instanceof SqliteReadOnlyProviderUnavailableError)) throw error;
    throw new LegacyImportDatabaseTargetInspectionError(
      "provider",
      "LEGACY_IMPORT_DATABASE_INSPECTION_PROVIDER_UNAVAILABLE",
      "legacy import database inspection requires an available SQLite provider",
      false,
    );
  }
}

const DEFAULT_DEPS: LegacyImportDatabaseTargetInspectorDeps = {
  makeTemporaryDirectory: () => mkdtempSync(join(tmpdir(), "gsd-legacy-db-inspect-")),
  writePrivateFile: (path, bytes) => writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }),
  readFile: (path) => readFileSync(path),
  removeTemporaryDirectory: (path) => rmSync(path, { recursive: true, force: true }),
  openReadOnly: defaultOpenReadOnly,
};

function firstValue(row: Record<string, unknown> | undefined): unknown {
  return row === undefined ? undefined : Object.values(row)[0];
}

function sqliteSchemaRows(db: DbAdapter): SchemaRow[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    ORDER BY type, name, tbl_name
  `).all().map((row) => {
    if (
      typeof row["type"] !== "string"
      || typeof row["name"] !== "string"
      || typeof row["tbl_name"] !== "string"
      || (row["sql"] !== null && typeof row["sql"] !== "string")
    ) throw new Error("invalid sqlite schema row");
    return {
      type: row["type"],
      name: row["name"],
      table: row["tbl_name"],
      sqlHash: hashLegacyImportValue(row["sql"] as LegacyImportValue),
    };
  });
}

function objectExists(rows: readonly SchemaRow[], type: string, name: string): boolean {
  return rows.some((row) => row.type === type && row.name === name);
}

function safeRowCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid sqlite row count");
  return value as number;
}

function coreRowCount(db: DbAdapter, rows: readonly SchemaRow[], table: string): number | null {
  if (!objectExists(rows, "table", table)) return null;
  return safeRowCount(firstValue(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()));
}

function schemaEvidence(db: DbAdapter): LegacyImportDatabaseTargetSchemaEvidence {
  const rows = sqliteSchemaRows(db);
  const versionObject = rows.find((row) => row.name === "schema_version");
  let versionRows: Record<string, unknown>[] = [];
  if (versionObject?.type === "table") {
    versionRows = db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
  }
  const versions: number[] = [];
  let invalidVersionCount = 0;
  for (const row of versionRows) {
    const version = row["version"];
    if (!Number.isSafeInteger(version) || (version as number) < 1) invalidVersionCount += 1;
    else versions.push(version as number);
  }
  versions.sort((left, right) => left - right);
  const uniqueVersions = [...new Set(versions)];
  const inspectCoreRows = uniqueVersions.length === 0;
  let versionTableKind: LegacyImportDatabaseTargetSchemaEvidence["version_table_kind"] = "other";
  if (versionObject === undefined) versionTableKind = "absent";
  else if (versionObject.type === "table") versionTableKind = "table";
  return {
    version_table_kind: versionTableKind,
    version_row_count: versionRows.length,
    versions: uniqueVersions,
    invalid_version_count: invalidVersionCount,
    schema_fingerprint: hashLegacyImportValue(rows.map((row) => ({
      type: row.type,
      name: row.name,
      table: row.table,
      sql_hash: row.sqlHash,
    }))),
    anchors: {
      project_authority: objectExists(rows, "table", "project_authority"),
      workflow_import_applications: objectExists(rows, "table", "workflow_import_applications"),
      milestone_reopen_trigger: objectExists(rows, "trigger", "trg_workflow_lifecycle_reopen_authorization"),
      authority_recovery_receipts: [
        "workflow_authority_cutovers",
        "workflow_import_restores",
        "workflow_import_forward_repairs",
      ].every((name) => objectExists(rows, "table", name)),
    },
    core_row_counts: {
      milestones: inspectCoreRows ? coreRowCount(db, rows, "milestones") : null,
      decisions: inspectCoreRows ? coreRowCount(db, rows, "decisions") : null,
      memories: inspectCoreRows ? coreRowCount(db, rows, "memories") : null,
    },
  };
}

function inspectCopy(
  request: LegacyImportDatabaseTargetInspectionRequest,
  path: string,
  deps: LegacyImportDatabaseTargetInspectorDeps,
): LegacyImportDatabaseTargetInspectionEvidence {
  let connection: LegacyImportDatabaseTargetInspectionConnection;
  try {
    connection = deps.openReadOnly(path);
  } catch (error) {
    if (error instanceof LegacyImportDatabaseTargetInspectionError) throw error;
    return rejectedEvidence(request, "open-failed");
  }
  try {
    try {
      configureSqliteReadOnly(connection);
    } catch {
      return rejectedEvidence(request, "open-failed");
    }
    let quickCheck: unknown;
    try {
      quickCheck = firstValue(connection.db.prepare("PRAGMA quick_check(1)").get());
    } catch {
      return rejectedEvidence(request, "quick-check-failed");
    }
    if (quickCheck !== "ok") return rejectedEvidence(request, "quick-check-failed");
    try {
      return sealEvidence(request, {
        kind: "sqlite",
        header: headerEvidence(request.bytes)!,
        quick_check: "ok",
        schema: schemaEvidence(connection.db),
      });
    } catch {
      return rejectedEvidence(request, "non-gsd");
    }
  } finally {
    try {
      connection.db.close();
    } catch {
      throw new LegacyImportDatabaseTargetInspectionError(
        "close",
        "LEGACY_IMPORT_DATABASE_INSPECTION_CLOSE_FAILED",
        "legacy import database inspection copy could not be closed safely",
        true,
        requestContext(request),
      );
    }
  }
}

function evidenceError(
  request: LegacyImportDatabaseTargetInspectionRequest,
  code: string,
  message: string,
  context: Record<string, string> = {},
): never {
  throw new LegacyImportDatabaseTargetInspectionError(
    "evidence",
    code,
    message,
    false,
    { ...requestContext(request), ...context },
  );
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${label}`);
  return value;
}

function tablePages(db: DbAdapter, table: string): number[] {
  return db.prepare(`
    SELECT pageno
    FROM dbstat
    WHERE name = ? AND pagetype IN ('leaf', 'overflow')
    ORDER BY pageno
  `).all(table).map((row) => {
    const page = row["pageno"];
    if (!Number.isSafeInteger(page) || (page as number) < 1) throw new Error("invalid database page");
    return page as number;
  });
}

function tableHasColumn(db: DbAdapter, table: "slices" | "slice_dependencies", column: string): boolean {
  const query = table === "slices"
    ? "PRAGMA table_info(slices)"
    : "PRAGMA table_info(slice_dependencies)";
  return db.prepare(query).all().some((row) => row["name"] === column);
}

function exactSpan(
  request: LegacyImportDatabaseTargetInspectionRequest,
  db: DbAdapter,
  table: string,
  field: string,
  rawValue: string,
): { start_byte: number; end_byte: number } {
  const pageSize = firstValue(db.prepare("PRAGMA page_size").get());
  if (!Number.isSafeInteger(pageSize) || (pageSize as number) < 512) {
    throw new Error("invalid database page size");
  }
  const needle = Buffer.from(rawValue, "utf8");
  const offsets: number[] = [];
  for (const page of tablePages(db, table)) {
    const pageStart = (page - 1) * (pageSize as number);
    const pageBytes = request.bytes.subarray(pageStart, pageStart + (pageSize as number));
    let offset = -1;
    while ((offset = pageBytes.indexOf(needle, offset + 1)) !== -1) {
      offsets.push(pageStart + offset);
    }
  }
  if (offsets.length === 0) {
    evidenceError(
      request,
      "LEGACY_IMPORT_DATABASE_EVIDENCE_SPAN_MISSING",
      "legacy import database evidence has no exact retained-byte span",
      { table, field, occurrence_count: "0" },
    );
  }
  if (offsets.length > 1) {
    evidenceError(
      request,
      "LEGACY_IMPORT_DATABASE_EVIDENCE_SPAN_AMBIGUOUS",
      "legacy import database evidence has multiple retained-byte spans",
      { table, field, occurrence_count: String(offsets.length) },
    );
  }
  return { start_byte: offsets[0]!, end_byte: offsets[0]! + needle.length };
}

function dependencyObservations(
  request: LegacyImportDatabaseTargetInspectionRequest,
  db: DbAdapter,
): LegacyImportGsdDatabaseObservation[] {
  const observations: LegacyImportGsdDatabaseObservation[] = [];
  if (tableHasColumn(db, "slices", "depends")) {
    for (const row of db.prepare(`
      SELECT milestone_id, id, depends
      FROM slices
      WHERE depends IS NOT NULL
      ORDER BY milestone_id, id
    `).all()) {
      const milestoneId = requireText(row["milestone_id"], "slices.milestone_id");
      const sliceId = requireText(row["id"], "slices.id");
      const rawValue = requireText(row["depends"], "slices.depends");
      const value = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        throw new Error("invalid slices.depends");
      }
      if (value.length === 0) continue;
      const locator = exactSpan(request, db, "slices", "depends", rawValue);
      observations.push({
        table: "slices",
        key: { milestone_id: milestoneId, id: sliceId },
        field: "depends",
        value,
        raw: { locator, value: rawValue, sha256: hashLegacyImportBytes(rawValue) },
      });
    }
  }
  if (tableHasColumn(db, "slice_dependencies", "depends_on_slice_id")) {
    for (const row of db.prepare(`
      SELECT milestone_id, slice_id, depends_on_slice_id
      FROM slice_dependencies
      ORDER BY milestone_id, slice_id, depends_on_slice_id
    `).all()) {
      const milestoneId = requireText(row["milestone_id"], "slice_dependencies.milestone_id");
      const sliceId = requireText(row["slice_id"], "slice_dependencies.slice_id");
      const rawValue = requireText(row["depends_on_slice_id"], "slice_dependencies.depends_on_slice_id");
      const locator = exactSpan(request, db, "slice_dependencies", "depends_on_slice_id", rawValue);
      observations.push({
        table: "slice_dependencies",
        key: { milestone_id: milestoneId, slice_id: sliceId },
        field: "depends_on_slice_id",
        value: rawValue,
        raw: { locator, value: rawValue, sha256: hashLegacyImportBytes(rawValue) },
      });
    }
  }
  return observations;
}

function inspectGsdDatabaseEvidenceCopy(
  request: LegacyImportDatabaseTargetInspectionRequest,
  path: string,
  deps: LegacyImportDatabaseTargetInspectorDeps,
): LegacyImportGsdDatabaseEvidence {
  let connection: LegacyImportDatabaseTargetInspectionConnection;
  try {
    connection = deps.openReadOnly(path);
  } catch (error) {
    if (error instanceof LegacyImportDatabaseTargetInspectionError) throw error;
    evidenceError(request, "LEGACY_IMPORT_DATABASE_EVIDENCE_OPEN_FAILED", "legacy import database evidence copy cannot be opened");
  }
  try {
    let observations: LegacyImportGsdDatabaseObservation[];
    try {
      configureSqliteReadOnly(connection);
      if (firstValue(connection.db.prepare("PRAGMA quick_check(1)").get()) !== "ok") {
        evidenceError(
          request,
          "LEGACY_IMPORT_DATABASE_EVIDENCE_QUICK_CHECK_FAILED",
          "legacy import database evidence copy failed integrity validation",
        );
      }
      observations = dependencyObservations(request, connection.db);
    } catch (error) {
      if (error instanceof LegacyImportDatabaseTargetInspectionError) throw error;
      evidenceError(
        request,
        "LEGACY_IMPORT_DATABASE_EVIDENCE_QUERY_FAILED",
        "legacy import database dependency evidence cannot be queried",
      );
    }
    const sliceCount = observations.filter((entry) => entry.table === "slices").length;
    const dependencyCount = observations.length - sliceCount;
    const value = {
      evidence_version: 1 as const,
      inspection_version: 1 as const,
      capture_hash: request.capture_hash,
      source_id: request.source_id,
      source_sha256: request.source_sha256,
      source_byte_size: request.source_byte_size,
      coverage: [
        {
          table: "slices" as const,
          field: "depends" as const,
          complete: true as const,
          row_count: sliceCount,
        },
        {
          table: "slice_dependencies" as const,
          field: "depends_on_slice_id" as const,
          complete: true as const,
          row_count: dependencyCount,
        },
      ],
      observations,
    };
    return deepFreeze({ ...value, evidence_hash: hashLegacyImportValue(value) });
  } finally {
    try {
      connection.db.close();
    } catch {
      throw new LegacyImportDatabaseTargetInspectionError(
        "close",
        "LEGACY_IMPORT_DATABASE_INSPECTION_CLOSE_FAILED",
        "legacy import database inspection copy could not be closed safely",
        true,
        requestContext(request),
      );
    }
  }
}

function inspectRetainedCopy<T>(
  request: LegacyImportDatabaseTargetInspectionRequest,
  deps: LegacyImportDatabaseTargetInspectorDeps,
  inspect: (path: string) => T,
): T {
  let directory: string;
  try {
    directory = deps.makeTemporaryDirectory();
  } catch {
    throw new LegacyImportDatabaseTargetInspectionError(
      "materialize",
      "LEGACY_IMPORT_DATABASE_INSPECTION_TEMP_FAILED",
      "legacy import database inspection copy could not be created",
      true,
      requestContext(request),
    );
  }
  const path = join(directory, "candidate.db");
  let copyCreated = false;
  try {
    try {
      deps.writePrivateFile(path, Buffer.from(request.bytes));
      const materialized = deps.readFile(path);
      if (materialized.length !== request.source_byte_size || hashLegacyImportBytes(materialized) !== request.source_sha256) {
        throw new Error("copy mismatch");
      }
      copyCreated = true;
    } catch {
      throw new LegacyImportDatabaseTargetInspectionError(
        "materialize",
        "LEGACY_IMPORT_DATABASE_INSPECTION_COPY_FAILED",
        "legacy import database inspection copy is inconsistent",
        true,
        requestContext(request),
      );
    }
    return inspect(path);
  } finally {
    let copyChanged = false;
    if (copyCreated) {
      try {
        const materialized = deps.readFile(path);
        copyChanged = materialized.length !== request.source_byte_size
          || hashLegacyImportBytes(materialized) !== request.source_sha256;
      } catch {
        copyChanged = true;
      }
    }
    try {
      deps.removeTemporaryDirectory(directory);
    } catch {
      throw new LegacyImportDatabaseTargetInspectionError(
        "cleanup",
        "LEGACY_IMPORT_DATABASE_INSPECTION_CLEANUP_FAILED",
        "legacy import database inspection copy could not be removed safely",
        true,
        requestContext(request),
      );
    }
    if (copyChanged) {
      throw new LegacyImportDatabaseTargetInspectionError(
        "cleanup",
        "LEGACY_IMPORT_DATABASE_INSPECTION_COPY_CHANGED",
        "legacy import database inspection copy changed during read-only inspection",
        false,
        requestContext(request),
      );
    }
  }
}

export function inspectLegacyImportDatabaseTarget(
  request: LegacyImportDatabaseTargetInspectionRequest,
  deps: LegacyImportDatabaseTargetInspectorDeps = DEFAULT_DEPS,
): LegacyImportDatabaseTargetInspectionEvidence {
  validateRequest(request);
  if (headerEvidence(request.bytes) === undefined) return rejectedEvidence(request, "invalid-header");
  return inspectRetainedCopy(request, deps, (path) => inspectCopy(request, path, deps));
}

export function inspectLegacyImportGsdDatabaseEvidence(
  request: LegacyImportDatabaseTargetInspectionRequest,
  deps: LegacyImportDatabaseTargetInspectorDeps = DEFAULT_DEPS,
): LegacyImportGsdDatabaseEvidence {
  validateRequest(request);
  if (headerEvidence(request.bytes) === undefined) {
    evidenceError(
      request,
      "LEGACY_IMPORT_DATABASE_EVIDENCE_INVALID_HEADER",
      "legacy import database evidence requires valid SQLite bytes",
    );
  }
  return inspectRetainedCopy(request, deps, (path) => inspectGsdDatabaseEvidenceCopy(request, path, deps));
}
