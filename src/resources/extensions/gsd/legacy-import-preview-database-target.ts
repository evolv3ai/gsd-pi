// Project/App: gsd-pi
// File Purpose: Capture-bound database target selection and pure interpretation for legacy import Preview.

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  type LegacyImportPreviewResolution,
  type LegacyImportSha256,
  type LegacyImportTarget,
} from "./legacy-import-contract.js";
import {
  decodeLegacyImportCapture,
  finalizeLegacyImportInterpretation,
  type LegacyImportDecodedSourceFile,
  type LegacyImportInterpretation,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";
import type {
  LegacyImportSourceCapture,
  LegacyImportSourceCapturedRoot,
} from "./legacy-import-preview-source.js";
import { hashLegacyImportBytes, hashLegacyImportValue } from "./legacy-import-preview.js";

const DATABASE_PARSER_ID = "gsd-sqlite-target";
const CURRENT_DATABASE_SCHEMA_VERSION = LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION;
const EXTERNAL_ROOT_PATTERN = /^\$GSD_STATE_DIR\/projects\/[^/]+$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type LegacyImportDatabaseTargetRootKind = "project" | "external";

export interface LegacyImportDatabaseTargetInspectionRequest {
  capture_hash: LegacyImportSha256;
  source_id: LegacyImportSha256;
  root_kind: LegacyImportDatabaseTargetRootKind;
  logical_path: string;
  source_sha256: LegacyImportSha256;
  source_byte_size: number;
  bytes: Buffer;
}

export interface LegacyImportDatabaseTargetHeaderEvidence {
  page_size: number;
  read_version: number;
  write_version: number;
}

export interface LegacyImportDatabaseTargetSchemaEvidence {
  version_table_kind: "table" | "absent" | "other";
  version_row_count: number;
  versions: readonly number[];
  invalid_version_count: number;
  schema_fingerprint: LegacyImportSha256;
  anchors: {
    project_authority: boolean;
    workflow_import_applications: boolean;
    milestone_reopen_trigger: boolean;
    authority_recovery_receipts: boolean;
  };
  core_row_counts: {
    milestones: number | null;
    decisions: number | null;
    memories: number | null;
  };
}

export interface LegacyImportDatabaseTargetInspectionEvidence {
  evidence_version: 1;
  inspection_version: 1;
  capture_hash: LegacyImportSha256;
  source_id: LegacyImportSha256;
  root_kind: LegacyImportDatabaseTargetRootKind;
  logical_path: string;
  source_sha256: LegacyImportSha256;
  source_byte_size: number;
  sidecars: readonly [];
  inspection:
    | {
      kind: "rejected";
      reason: "invalid-header" | "open-failed" | "quick-check-failed" | "non-gsd";
      failure_fingerprint: LegacyImportSha256;
    }
    | {
      kind: "sqlite";
      header: LegacyImportDatabaseTargetHeaderEvidence;
      quick_check: "ok";
      schema: LegacyImportDatabaseTargetSchemaEvidence;
    };
  evidence_hash: LegacyImportSha256;
}

export type LegacyImportDatabaseTargetInspector = (
  request: LegacyImportDatabaseTargetInspectionRequest,
) => LegacyImportDatabaseTargetInspectionEvidence;

export type LegacyImportDatabaseTargetErrorStage = "collect" | "interpret";

export class LegacyImportDatabaseTargetError extends Error {
  readonly stage: LegacyImportDatabaseTargetErrorStage;
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    stage: LegacyImportDatabaseTargetErrorStage,
    code: string,
    message: string,
    retryable: boolean,
    context: Record<string, string> = {},
  ) {
    super(message);
    this.name = "LegacyImportDatabaseTargetError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.context = Object.freeze({ ...context });
  }
}

type DatabaseSidecarRole = "wal" | "shm" | "journal";

interface DatabaseTargetGroup {
  rootKind: LegacyImportDatabaseTargetRootKind;
  mainPath: string;
  main?: LegacyImportDecodedSourceFile;
  sidecars: Readonly<Partial<Record<DatabaseSidecarRole, LegacyImportDecodedSourceFile>>>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function databaseMainPath(root: LegacyImportSourceCapturedRoot): string | undefined {
  if (root.kind === "project" && /(?:^|\/)\.gsd$/u.test(root.logical_path)) {
    return `${root.logical_path}/gsd.db`;
  }
  if (root.kind === "external" && EXTERNAL_ROOT_PATTERN.test(root.logical_path)) {
    return `${root.logical_path}/gsd.db`;
  }
  return undefined;
}

function databaseKind(path: string): string {
  if (path.endsWith("-wal")) return "sqlite-wal";
  if (path.endsWith("-shm")) return "sqlite-shm";
  if (path.endsWith("-journal")) return "sqlite-journal";
  return "sqlite-database";
}

function databaseTargetSpecs(capture: LegacyImportSourceCapture): readonly {
  rootId: string;
  rootKind: LegacyImportDatabaseTargetRootKind;
  mainPath: string;
}[] {
  return capture.roots.flatMap((root) => {
    const mainPath = databaseMainPath(root);
    if (mainPath === undefined) return [];
    return [{ rootId: root.id, rootKind: root.kind as LegacyImportDatabaseTargetRootKind, mainPath }];
  });
}

function decodeDatabaseTargetFiles(
  capture: LegacyImportSourceCapture,
): LegacyImportDecodedSourceFile[] {
  const roots = new Map(capture.roots.map((root) => [root.id, root]));
  const groupSpecs = databaseTargetSpecs(capture);
  const includedPaths = new Set(groupSpecs.flatMap(({ mainPath }) => [
    mainPath,
    `${mainPath}-wal`,
    `${mainPath}-shm`,
    `${mainPath}-journal`,
  ]));
  return decodeLegacyImportCapture(capture, {
    sourceLabel: "database target",
    includes: (entry) => {
      const root = roots.get(entry.root_id);
      return root !== undefined && root.kind !== "worktree" && includedPaths.has(entry.logical_path);
    },
    parserId: () => DATABASE_PARSER_ID,
    kind: databaseKind,
    parserVersion: "1",
  });
}

function targetGroups(
  capture: LegacyImportSourceCapture,
  files: readonly LegacyImportDecodedSourceFile[],
): DatabaseTargetGroup[] {
  const groupSpecs = databaseTargetSpecs(capture);
  const byPath = new Map(files.map((file) => [file.entry.logical_path, file]));
  const groups = groupSpecs.map(({ rootKind, mainPath }) => ({
    rootKind,
    mainPath,
    main: byPath.get(mainPath),
    sidecars: {
      wal: byPath.get(`${mainPath}-wal`),
      shm: byPath.get(`${mainPath}-shm`),
      journal: byPath.get(`${mainPath}-journal`),
    },
  })).filter((group) => group.main !== undefined || Object.values(group.sidecars).some(Boolean));
  return groups.sort((left, right) => compareText(left.mainPath, right.mainPath));
}

function eligibleMain(group: DatabaseTargetGroup): LegacyImportDecodedSourceFile | undefined {
  if (Object.values(group.sidecars).some(Boolean)) return undefined;
  return group.main?.entry.kind === "file" ? group.main : undefined;
}

function evidenceValue(
  evidence: LegacyImportDatabaseTargetInspectionEvidence,
): Omit<LegacyImportDatabaseTargetInspectionEvidence, "evidence_hash"> {
  const { evidence_hash: _evidenceHash, ...value } = evidence;
  return value;
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableSafeCount(value: unknown): value is number | null {
  return value === null || isSafeCount(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isValidHeader(header: unknown): header is LegacyImportDatabaseTargetHeaderEvidence {
  if (!hasExactKeys(header, ["page_size", "read_version", "write_version"])) return false;
  const pageSize = header["page_size"];
  const validPageSize = pageSize === 65_536
    || (typeof pageSize === "number" && pageSize >= 512 && pageSize <= 32_768
      && (pageSize & (pageSize - 1)) === 0);
  return validPageSize
    && (header["read_version"] === 1 || header["read_version"] === 2)
    && (header["write_version"] === 1 || header["write_version"] === 2);
}

function isValidSchema(schema: unknown): schema is LegacyImportDatabaseTargetSchemaEvidence {
  if (
    !hasExactKeys(schema, [
      "version_table_kind",
      "version_row_count",
      "versions",
      "invalid_version_count",
      "schema_fingerprint",
      "anchors",
      "core_row_counts",
    ])
    || !hasExactKeys(schema["anchors"], [
      "project_authority",
      "workflow_import_applications",
      "milestone_reopen_trigger",
      "authority_recovery_receipts",
    ])
    || !hasExactKeys(schema["core_row_counts"], ["milestones", "decisions", "memories"])
    || !Array.isArray(schema["versions"])
  ) return false;
  const anchors = schema["anchors"];
  const rowCounts = schema["core_row_counts"];
  const versions = schema["versions"];
  const versionTableKind = schema["version_table_kind"];
  if (
    (versionTableKind !== "table" && versionTableKind !== "absent" && versionTableKind !== "other")
    || !isSafeCount(schema["version_row_count"])
    || !isSafeCount(schema["invalid_version_count"])
    || typeof schema["schema_fingerprint"] !== "string"
    || !SHA256_PATTERN.test(schema["schema_fingerprint"])
    || !isNullableSafeCount(rowCounts["milestones"])
    || !isNullableSafeCount(rowCounts["decisions"])
    || !isNullableSafeCount(rowCounts["memories"])
    || typeof anchors["project_authority"] !== "boolean"
    || typeof anchors["workflow_import_applications"] !== "boolean"
    || typeof anchors["milestone_reopen_trigger"] !== "boolean"
    || typeof anchors["authority_recovery_receipts"] !== "boolean"
    || versions.some((version) => !Number.isSafeInteger(version) || (version as number) < 1)
  ) return false;
  const numericVersions = versions as number[];
  const sorted = [...numericVersions].sort((left, right) => left - right);
  return new Set(numericVersions).size === numericVersions.length
    && sorted.every((version, index) => version === numericVersions[index]);
}

function isValidInspection(
  inspection: unknown,
): inspection is LegacyImportDatabaseTargetInspectionEvidence["inspection"] {
  if (!hasExactKeys(inspection, inspection !== null && typeof inspection === "object"
    && (inspection as { kind?: unknown }).kind === "rejected"
    ? ["kind", "reason", "failure_fingerprint"]
    : ["kind", "header", "quick_check", "schema"])) return false;
  if (inspection["kind"] === "rejected") {
    const reason = inspection["reason"];
    return (reason === "invalid-header" || reason === "open-failed"
      || reason === "quick-check-failed" || reason === "non-gsd")
      && typeof inspection["failure_fingerprint"] === "string"
      && SHA256_PATTERN.test(inspection["failure_fingerprint"]);
  }
  return inspection["kind"] === "sqlite"
    && inspection["quick_check"] === "ok"
    && isValidHeader(inspection["header"])
    && isValidSchema(inspection["schema"]);
}

function invalidEvidence(
  stage: LegacyImportDatabaseTargetErrorStage,
  evidence: unknown,
): never {
  const context: Record<string, string> = {};
  if (evidence !== null && typeof evidence === "object") {
    const candidate = evidence as { source_id?: unknown; logical_path?: unknown };
    if (typeof candidate.source_id === "string") context.source_id = candidate.source_id;
    if (typeof candidate.logical_path === "string") context.logical_path = candidate.logical_path;
  }
  throw new LegacyImportDatabaseTargetError(
    stage,
    "LEGACY_IMPORT_DATABASE_EVIDENCE_INVALID",
    "legacy import database target evidence is invalid",
    false,
    context,
  );
}

function validateEvidence(
  stage: LegacyImportDatabaseTargetErrorStage,
  capture: LegacyImportSourceCapture,
  group: DatabaseTargetGroup,
  evidence: LegacyImportDatabaseTargetInspectionEvidence,
): void {
  if (!hasExactKeys(evidence, [
    "evidence_version",
    "inspection_version",
    "capture_hash",
    "source_id",
    "root_kind",
    "logical_path",
    "source_sha256",
    "source_byte_size",
    "sidecars",
    "inspection",
    "evidence_hash",
  ]) || !Array.isArray(evidence["sidecars"]) || !isValidInspection(evidence["inspection"])) {
    invalidEvidence(stage, evidence);
  }
  const main = eligibleMain(group);
  let validHash = false;
  try {
    validHash = typeof evidence.evidence_hash === "string"
      && SHA256_PATTERN.test(evidence.evidence_hash)
      && hashLegacyImportValue(evidenceValue(evidence)) === evidence.evidence_hash;
  } catch {
    invalidEvidence(stage, evidence);
  }
  const invalidIdentity = main === undefined
    || evidence.evidence_version !== 1
    || evidence.inspection_version !== 1
    || evidence.capture_hash !== capture.capture_hash
    || evidence.source_id !== main.entry.source_id
    || evidence.root_kind !== group.rootKind
    || evidence.logical_path !== group.mainPath
    || evidence.source_sha256 !== main.entry.sha256
    || evidence.source_byte_size !== main.bytes.length
    || evidence.sidecars.length !== 0
    || !validHash;
  if (invalidIdentity) {
    throw new LegacyImportDatabaseTargetError(
      stage,
      "LEGACY_IMPORT_DATABASE_EVIDENCE_SOURCE_INCONSISTENT",
      "legacy import database target evidence source is inconsistent",
      false,
      { source_id: evidence.source_id, logical_path: evidence.logical_path },
    );
  }
}

export function collectLegacyImportDatabaseTargetEvidence(
  capture: LegacyImportSourceCapture,
  inspect: LegacyImportDatabaseTargetInspector,
): readonly LegacyImportDatabaseTargetInspectionEvidence[] {
  const files = decodeDatabaseTargetFiles(capture);
  const groups = targetGroups(capture, files);
  const evidence = groups.flatMap((group) => {
    const main = eligibleMain(group);
    if (main === undefined) return [];
    const inspected = inspect({
      capture_hash: capture.capture_hash,
      source_id: main.entry.source_id,
      root_kind: group.rootKind,
      logical_path: group.mainPath,
      source_sha256: main.entry.sha256!,
      source_byte_size: main.bytes.length,
      bytes: Buffer.from(main.bytes),
    });
    validateEvidence("collect", capture, group, inspected);
    return [inspected];
  });
  return Object.freeze(evidence);
}

function evidenceBySource(
  capture: LegacyImportSourceCapture,
  groups: readonly DatabaseTargetGroup[],
  evidenceSet: readonly LegacyImportDatabaseTargetInspectionEvidence[],
): Map<string, LegacyImportDatabaseTargetInspectionEvidence> {
  const eligible = new Map(groups.flatMap((group) => {
    const main = eligibleMain(group);
    return main === undefined ? [] : [[main.entry.source_id, group] as const];
  }));
  const evidence = new Map<string, LegacyImportDatabaseTargetInspectionEvidence>();
  for (const candidate of evidenceSet) {
    const group = eligible.get(candidate.source_id);
    if (group === undefined || evidence.has(candidate.source_id)) {
      throw new LegacyImportDatabaseTargetError(
        "interpret",
        "LEGACY_IMPORT_DATABASE_EVIDENCE_UNEXPECTED",
        "legacy import database target evidence is duplicated or unexpected",
        false,
        { source_id: candidate.source_id, logical_path: candidate.logical_path },
      );
    }
    validateEvidence("interpret", capture, group, candidate);
    evidence.set(candidate.source_id, candidate);
  }
  for (const sourceId of eligible.keys()) {
    if (!evidence.has(sourceId)) {
      throw new LegacyImportDatabaseTargetError(
        "interpret",
        "LEGACY_IMPORT_DATABASE_EVIDENCE_MISSING",
        "legacy import database target evidence is incomplete",
        true,
        { source_id: sourceId },
      );
    }
  }
  return evidence;
}

function redactedDiagnosis(
  file: LegacyImportDecodedSourceFile,
  code: string,
  severity: "info" | "warning" | "blocker",
  message: string,
  resolution: Omit<LegacyImportPreviewResolution, "diagnosis_id">,
): LegacyImportPendingDiagnosis {
  if (file.bytes.length === 0) {
    throw new LegacyImportDatabaseTargetError(
      "interpret",
      "LEGACY_IMPORT_DATABASE_EMPTY_SOURCE",
      "legacy import database target has no bytes for exact diagnostic provenance",
      false,
      { source_id: file.entry.source_id, logical_path: file.entry.logical_path },
    );
  }
  const end = Math.min(16, file.bytes.length);
  const identity = {
    code,
    severity,
    source_id: file.entry.source_id,
    locator: { start_byte: 0, end_byte: end },
    raw_value: { redacted: true as const, sha256: hashLegacyImportBytes(file.bytes.subarray(0, end)) },
    message,
  };
  return { diagnosis_id: hashLegacyImportValue(identity), ...identity, resolution };
}

function targetFor(group: DatabaseTargetGroup): LegacyImportTarget {
  return { kind: "database-target", key: group.mainPath };
}

function hasCompleteWalSidecars(group: DatabaseTargetGroup): boolean {
  return group.main?.entry.kind === "file"
    && group.sidecars.wal?.entry.kind === "file"
    && group.sidecars.shm?.entry.kind === "file"
    && group.sidecars.journal === undefined;
}

function sidecarDiagnosis(group: DatabaseTargetGroup): LegacyImportPendingDiagnosis {
  const main = group.main;
  const sidecars = Object.values(group.sidecars).filter((file): file is LegacyImportDecodedSourceFile => file !== undefined);
  const anchor = main ?? sidecars[0]!;
  if (hasCompleteWalSidecars(group)) {
    return redactedDiagnosis(
      anchor,
      "wal-sidecars-present",
      "warning",
      "The database, WAL, and shared-memory entries are one preservation unit and are not opened during classification.",
      { disposition: "preserved", target: targetFor(group) },
    );
  }
  const code = main === undefined ? "orphaned-database-sidecars" : "incomplete-database-sidecars";
  return redactedDiagnosis(
    anchor,
    code,
    "blocker",
    "The database journal entries are incomplete or unsupported and remain unopened preservation evidence.",
    main === undefined
      ? { disposition: "unsupported" }
      : { disposition: "preserved", target: targetFor(group) },
  );
}

function anchorFactsMatch(version: number, schema: LegacyImportDatabaseTargetSchemaEvidence): boolean {
  return schema.anchors.project_authority === (version >= 31)
    && schema.anchors.workflow_import_applications === (version >= 35)
    && schema.anchors.milestone_reopen_trigger === (version >= 44)
    && schema.anchors.authority_recovery_receipts === (version >= 45);
}

function coreDatabaseIsPopulated(schema: LegacyImportDatabaseTargetSchemaEvidence): boolean {
  return Object.values(schema.core_row_counts).some((count) => count !== null && count > 0);
}

function historicalMessage(version: number): string {
  if (version === 30) return "Schema v30 is a supported historical target before the canonical authority foundation.";
  if (version === 34) return "Schema v34 is a supported historical target before the import application foundation.";
  if (version === 43) return "Schema v43 is a supported historical target before milestone reopen authorization.";
  return `Schema v${version} is a supported historical database target.`;
}

function interpretInspectedGroup(
  group: DatabaseTargetGroup,
  evidence: LegacyImportDatabaseTargetInspectionEvidence,
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  const main = group.main!;
  const inspection = evidence.inspection;
  if (inspection.kind === "rejected") {
    main.outcome = "unparsed";
    diagnoses.push(redactedDiagnosis(
      main,
      "corrupt-database",
      "blocker",
      "The target is not an openable SQLite database and cannot be classified safely.",
      { disposition: "unsupported" },
    ));
    return;
  }
  const { schema } = inspection;
  const malformedVersion = schema.version_table_kind === "other"
    || schema.invalid_version_count !== 0
    || schema.version_row_count !== schema.versions.length;
  if (malformedVersion) {
    main.outcome = "unparsed";
    diagnoses.push(redactedDiagnosis(
      main,
      "invalid-database-schema-metadata",
      "blocker",
      "The target has inconsistent schema metadata and cannot be classified safely.",
      { disposition: "unsupported" },
    ));
    return;
  }
  const version = schema.versions.at(-1);
  if (version !== undefined && version > CURRENT_DATABASE_SCHEMA_VERSION) {
    main.outcome = "unparsed";
    diagnoses.push(redactedDiagnosis(
      main,
      "future-schema-version",
      "blocker",
      `Schema v${version} is newer than the accepted v${CURRENT_DATABASE_SCHEMA_VERSION} target and must remain untouched.`,
      { disposition: "unsupported" },
    ));
    return;
  }
  if (version !== undefined && anchorFactsMatch(version, schema)) {
    main.outcome = "mapped";
    if (version < CURRENT_DATABASE_SCHEMA_VERSION) {
      diagnoses.push(redactedDiagnosis(
        main,
        "historical-schema-version",
        "info",
        historicalMessage(version),
        { disposition: "mapped", target: targetFor(group) },
      ));
    }
    return;
  }
  const unversioned = version === undefined
    && (schema.version_table_kind === "table" || schema.version_table_kind === "absent")
    && coreDatabaseIsPopulated(schema);
  if (unversioned) {
    main.outcome = "mapped";
    diagnoses.push(redactedDiagnosis(
      main,
      "unversioned-populated-database",
      "warning",
      "The populated database has no version row and is classified from baseline v1 without changing it.",
      { disposition: "mapped", target: targetFor(group) },
    ));
    return;
  }
  main.outcome = "unparsed";
  diagnoses.push(redactedDiagnosis(
    main,
    "unsupported-database-schema",
    "blocker",
    "The SQLite target does not match a supported GSD schema boundary.",
    { disposition: "unsupported" },
  ));
}

function markDatabaseFiles(files: readonly LegacyImportDecodedSourceFile[]): void {
  for (const file of files) {
    file.parserId = DATABASE_PARSER_ID;
    file.parserVersion = "1";
    file.kind = databaseKind(file.entry.logical_path);
    file.encoding = "binary";
  }
}

function competingTargetDiagnosis(groups: readonly DatabaseTargetGroup[]): LegacyImportPendingDiagnosis | undefined {
  const targets = groups.filter((group) => group.main !== undefined);
  if (targets.length < 2) return undefined;
  const anchor = targets[0]!.main!;
  return redactedDiagnosis(
    anchor,
    "competing-database-targets",
    "blocker",
    "Multiple database targets exist; Preview cannot choose which captured root owns authority.",
    { disposition: "requires-user" },
  );
}

export function contributeLegacyImportDatabaseTargets(
  capture: LegacyImportSourceCapture,
  files: readonly LegacyImportDecodedSourceFile[],
  evidenceSet: readonly LegacyImportDatabaseTargetInspectionEvidence[],
  diagnoses: LegacyImportPendingDiagnosis[],
): ReadonlySet<string> {
  const groups = targetGroups(capture, files);
  const claimed = new Set<string>();
  for (const group of groups) {
    if (group.main !== undefined) claimed.add(group.main.entry.source_id);
    for (const sidecar of Object.values(group.sidecars)) {
      if (sidecar !== undefined) claimed.add(sidecar.entry.source_id);
    }
  }
  const claimedFiles = files.filter((file) => claimed.has(file.entry.source_id));
  markDatabaseFiles(claimedFiles);
  const evidence = evidenceBySource(capture, groups, evidenceSet);
  for (const group of groups) {
    const sidecars = Object.values(group.sidecars).filter(Boolean);
    if (sidecars.length > 0) {
      const completeWal = hasCompleteWalSidecars(group);
      if (group.main !== undefined) group.main.outcome = completeWal ? "mapped" : "unparsed";
      for (const sidecar of sidecars) sidecar!.outcome = "preserved";
      diagnoses.push(sidecarDiagnosis(group));
      continue;
    }
    if (group.main?.entry.kind === "symlink") {
      group.main.outcome = "unparsed";
      diagnoses.push(redactedDiagnosis(
        group.main,
        "unsupported-database-symlink",
        "blocker",
        "A legacy database target must be a retained regular file and is never followed through a symlink.",
        { disposition: "unsupported" },
      ));
      continue;
    }
    if (group.main !== undefined) interpretInspectedGroup(group, evidence.get(group.main.entry.source_id)!, diagnoses);
  }
  const competing = competingTargetDiagnosis(groups);
  if (competing !== undefined) diagnoses.push(competing);
  return claimed;
}

export function interpretLegacyImportDatabaseTargets(
  capture: LegacyImportSourceCapture,
  evidenceSet: readonly LegacyImportDatabaseTargetInspectionEvidence[],
): LegacyImportInterpretation {
  const files = decodeDatabaseTargetFiles(capture);
  const diagnoses: LegacyImportPendingDiagnosis[] = [];
  contributeLegacyImportDatabaseTargets(capture, files, evidenceSet, diagnoses);
  return finalizeLegacyImportInterpretation(files, [], diagnoses);
}
