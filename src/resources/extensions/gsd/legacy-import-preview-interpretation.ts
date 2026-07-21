// Project/App: gsd-pi
// File Purpose: Shared byte-backed interpretation primitives for legacy import previews.

import { compareText, deepFreeze } from "./legacy-import-utils.js";

import { isUtf8 } from "node:buffer";

import type {
  LegacyImportPreviewDiagnosis,
  LegacyImportPreviewResolution,
  LegacyImportPreviewSource,
  LegacyImportProvenance,
  LegacyImportRawValue,
  LegacyImportSha256,
  LegacyImportTarget,
  LegacyImportValue,
} from "./legacy-import-contract.js";
import type { LegacyImportBaseRowSet } from "./legacy-import-preview-base.js";
import type {
  LegacyImportSourceCapture,
  LegacyImportSourceEntry,
} from "./legacy-import-preview-source.js";
import {
  canonicalLegacyImportJson,
  hashLegacyImportBytes,
  hashLegacyImportValue,
} from "./legacy-import-preview.js";

const CAPTURE_ROOT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface LegacyImportInterpretationCandidate {
  candidate_id: LegacyImportSha256;
  ordinal: number;
  classification: "compare" | "preserve";
  target: LegacyImportTarget;
  raw: LegacyImportRawValue;
  normalized: LegacyImportValue;
  provenance: LegacyImportProvenance;
  reason_code: string;
}

export interface LegacyImportCompleteRowSet {
  complete_set_id: LegacyImportSha256;
  row_set: LegacyImportBaseRowSet;
  target_kind: string;
  member_keys: readonly string[];
  raw: LegacyImportRawValue;
  preview_raw?: LegacyImportRawValue;
  provenance: LegacyImportProvenance;
}

export type LegacyImportPendingCompleteRowSet = Omit<
  LegacyImportCompleteRowSet,
  "complete_set_id"
>;

export interface LegacyImportInterpretation {
  sources: readonly LegacyImportPreviewSource[];
  candidates: readonly LegacyImportInterpretationCandidate[];
  complete_row_sets: readonly LegacyImportCompleteRowSet[];
  diagnoses: readonly LegacyImportPreviewDiagnosis[];
  resolutions: readonly LegacyImportPreviewResolution[];
}

export interface LegacyImportSourceLine {
  text: string;
  start: number;
  end: number;
  line: number;
}

export interface LegacyImportDecodedSourceFile {
  entry: LegacyImportSourceEntry;
  bytes: Buffer;
  text: string;
  lines: readonly LegacyImportSourceLine[];
  parserId: string;
  parserVersion: string;
  kind: string;
  encoding: "utf-8" | "binary";
  outcome: "mapped" | "preserved" | "unparsed" | "ignored-with-reason";
}

export interface LegacyImportPendingCandidate {
  classification: "compare" | "preserve";
  target: LegacyImportTarget;
  raw: LegacyImportRawValue;
  normalized: LegacyImportValue;
  provenance: LegacyImportProvenance;
  reason_code: string;
}

export interface LegacyImportPendingDiagnosis extends LegacyImportPreviewDiagnosis {
  resolution: Omit<LegacyImportPreviewResolution, "diagnosis_id">;
}

export interface LegacyImportCaptureDecoder {
  sourceLabel: string;
  includes(entry: LegacyImportSourceEntry): boolean;
  parserId(path: string): string;
  kind(path: string): string;
  parserVersion: string;
}

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function candidateOrderValue(candidate: LegacyImportPendingCandidate): LegacyImportValue {
  return [
    candidate.target.kind,
    candidate.target.key,
    candidate.target.field === undefined ? 0 : 1,
    candidate.target.field ?? "",
    candidate.raw.source_id,
    candidate.raw.locator.start_byte,
    candidate.reason_code,
    candidate.classification,
  ];
}

function completeRowSetOrderValue(rowSet: LegacyImportCompleteRowSet): LegacyImportValue {
  return [
    rowSet.row_set,
    rowSet.target_kind,
    rowSet.raw.source_id,
    rowSet.raw.locator.start_byte,
    rowSet.complete_set_id,
  ];
}

function finalizeCompleteRowSets(
  pendingRowSets: readonly LegacyImportPendingCompleteRowSet[],
): LegacyImportCompleteRowSet[] {
  const claims = new Set<string>();
  return pendingRowSets.map((pending) => {
    if (pending.target_kind.trim().length === 0) {
      throw new Error("legacy import complete row-set target kind must not be blank");
    }
    if (pending.raw.source_id !== pending.provenance.source_id) {
      throw new Error("legacy import complete row-set provenance must match its raw source");
    }
    const memberKeys = [...pending.member_keys].sort(compareText);
    if (
      memberKeys.some((key) => key.trim().length === 0)
      || new Set(memberKeys).size !== memberKeys.length
    ) {
      throw new Error("legacy import complete row-set member keys must be unique non-blank values");
    }
    const claim = canonicalLegacyImportJson([
      pending.row_set,
      pending.target_kind,
      pending.raw.source_id,
    ]);
    if (claims.has(claim)) {
      throw new Error("legacy import complete row-set claim is duplicated");
    }
    claims.add(claim);
    const identity: LegacyImportPendingCompleteRowSet = {
      ...pending,
      member_keys: memberKeys,
    };
    return { complete_set_id: hashLegacyImportValue(identity), ...identity };
  }).sort((left, right) => compareText(
    canonicalLegacyImportJson(completeRowSetOrderValue(left)),
    canonicalLegacyImportJson(completeRowSetOrderValue(right)),
  ));
}

function linesFor(bytes: Buffer): LegacyImportSourceLine[] {
  const lines: LegacyImportSourceLine[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 10) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 13) end -= 1;
    if (start < bytes.length || index < bytes.length) {
      lines.push({ text: bytes.subarray(start, end).toString("utf8"), start, end, line: number });
    }
    start = index + 1;
    number += 1;
  }
  return lines;
}

function lineAtByte(file: LegacyImportDecodedSourceFile, start: number): number {
  let line = 1;
  for (const candidate of file.lines) {
    if (candidate.start > start) break;
    line = candidate.line;
  }
  return line;
}

export function rawLegacyImportValue(
  file: LegacyImportDecodedSourceFile,
  start = 0,
  end = file.bytes.length,
): LegacyImportRawValue {
  const bytes = file.bytes.subarray(start, end);
  return {
    source_id: file.entry.source_id,
    locator: { start_byte: start, end_byte: end, line: lineAtByte(file, start) },
    value: bytes.toString("utf8"),
    sha256: hashLegacyImportBytes(bytes),
  };
}

export function decodeLegacyImportCapture(
  capture: LegacyImportSourceCapture,
  decoder: LegacyImportCaptureDecoder,
): LegacyImportDecodedSourceFile[] {
  const { capture_hash: captureHash, ...captureValue } = capture;
  if (capture.capture_version !== 1 || hashLegacyImportValue(captureValue) !== captureHash) {
    throw new Error(`captured ${decoder.sourceLabel} source set identity is inconsistent`);
  }
  const payloads = new Map<string, LegacyImportSourceCapture["payloads"][number]>();
  for (const payload of capture.payloads) {
    if (
      !isNonblankString(payload.payload_id)
      || (payload.kind !== "file" && payload.kind !== "symlink")
      || !Number.isSafeInteger(payload.byte_size)
      || payload.byte_size < 0
      || !isNonblankString(payload.sha256)
      || typeof payload.bytes_base64 !== "string"
    ) {
      throw new Error(`captured ${decoder.sourceLabel} payload metadata is inconsistent`);
    }
    if (payloads.has(payload.payload_id)) {
      throw new Error(`captured ${decoder.sourceLabel} payload ${payload.payload_id} is duplicated`);
    }
    payloads.set(payload.payload_id, payload);
  }
  const sourceIds = new Set<string>();
  const logicalPaths = new Set<string>();
  const referencedPayloadIds = new Set<string>();
  const capturedRootIds = new Set<string>();
  if (capture.roots.length === 0) {
    throw new Error(`captured ${decoder.sourceLabel} source set has no roots`);
  }
  for (const root of capture.roots) {
    if (
      !isNonblankString(root.id)
      || !CAPTURE_ROOT_ID_PATTERN.test(root.id)
      || (root.kind !== "project" && root.kind !== "external" && root.kind !== "worktree")
      || (root.presence !== "required" && root.presence !== "optional")
      || (root.observed !== "present" && root.observed !== "absent")
      || (root.presence === "required" && root.observed === "absent")
      || !isNonblankString(root.physical_path)
      || !isNonblankString(root.logical_path)
      || (root.observed === "present" && (
        !isNonblankString(root.physical_identity)
        || !isNonblankString(root.real_path)
      ))
      || (root.observed === "absent" && (
        root.physical_identity !== undefined
        || root.real_path !== undefined
      ))
    ) {
      throw new Error(`captured ${decoder.sourceLabel} root ${root.id} metadata is inconsistent`);
    }
  }
  const roots = new Map(capture.roots.map((root) => [root.id, root]));
  if (roots.size !== capture.roots.length) {
    throw new Error(`captured ${decoder.sourceLabel} roots are duplicated`);
  }
  const files = capture.entries.flatMap((entry) => {
    const root = roots.get(entry.root_id);
    if (
      !isNonblankString(entry.root_id)
      || !isNonblankString(entry.logical_path)
      || !isNonblankString(entry.physical_identity)
      || root === undefined
      || root.observed !== "present"
      || (entry.kind !== "directory" && entry.kind !== "file" && entry.kind !== "symlink")
      || !(
        entry.logical_path === root.logical_path
        || entry.logical_path.startsWith(`${root.logical_path}/`)
      )
      || entry.source_id !== hashLegacyImportValue({
        source_capture_version: 1,
        root_kind: root.kind,
        logical_path: entry.logical_path,
      })
    ) {
      throw new Error(`captured ${decoder.sourceLabel} source ${entry.logical_path} identity is inconsistent`);
    }
    if (sourceIds.has(entry.source_id) || logicalPaths.has(entry.logical_path)) {
      throw new Error(`captured ${decoder.sourceLabel} source ${entry.logical_path} is duplicated`);
    }
    sourceIds.add(entry.source_id);
    logicalPaths.add(entry.logical_path);
    if (entry.logical_path === root.logical_path) {
      if (entry.physical_identity !== root.physical_identity) {
        throw new Error(`captured ${decoder.sourceLabel} root ${root.id} identity is inconsistent`);
      }
      capturedRootIds.add(root.id);
    }
    if (entry.kind === "directory") {
      if (
        entry.payload_id !== undefined
        || entry.byte_size !== undefined
        || entry.sha256 !== undefined
        || entry.symlink_target_identity !== undefined
      ) {
        throw new Error(`captured ${decoder.sourceLabel} source ${entry.logical_path} metadata is inconsistent`);
      }
      return [];
    }
    if (
      !isNonblankString(entry.payload_id)
      || !Number.isSafeInteger(entry.byte_size)
      || entry.byte_size! < 0
      || !isNonblankString(entry.sha256)
    ) {
      throw new Error(`captured ${decoder.sourceLabel} source ${entry.logical_path} lacks retained bytes`);
    }
    if (
      (entry.kind === "file" && entry.symlink_target_identity !== undefined)
      || (entry.kind === "symlink" && !isNonblankString(entry.symlink_target_identity))
    ) {
      throw new Error(`captured ${decoder.sourceLabel} source ${entry.logical_path} metadata is inconsistent`);
    }
    const payload = payloads.get(entry.payload_id);
    if (payload === undefined) {
      throw new Error(`captured ${decoder.sourceLabel} payload ${entry.payload_id} is missing`);
    }
    const expectedPayloadId = hashLegacyImportValue({
      source_capture_version: 1,
      kind: entry.kind,
      physical_identity: entry.physical_identity,
    });
    const bytes = Buffer.from(payload.bytes_base64, "base64");
    if (
      entry.payload_id !== expectedPayloadId
      || payload.payload_id !== expectedPayloadId
      || bytes.toString("base64") !== payload.bytes_base64
      || payload.kind !== entry.kind
      || bytes.length !== payload.byte_size
      || bytes.length !== entry.byte_size
      || hashLegacyImportBytes(bytes) !== payload.sha256
      || payload.sha256 !== entry.sha256
    ) {
      throw new Error(`captured ${decoder.sourceLabel} payload ${entry.payload_id} is inconsistent`);
    }
    referencedPayloadIds.add(entry.payload_id);
    if (!decoder.includes(entry)) return [];
    const validUtf8 = entry.kind === "file" && isUtf8(bytes);
    return [{
      entry,
      bytes,
      text: validUtf8 ? bytes.toString("utf8") : "",
      lines: validUtf8 ? linesFor(bytes) : [],
      parserId: decoder.parserId(entry.logical_path),
      parserVersion: decoder.parserVersion,
      kind: decoder.kind(entry.logical_path),
      encoding: validUtf8 ? "utf-8" as const : "binary" as const,
      outcome: "mapped" as const,
    }];
  });
  for (const payloadId of payloads.keys()) {
    if (!referencedPayloadIds.has(payloadId)) {
      throw new Error(`captured ${decoder.sourceLabel} payload ${payloadId} is orphaned`);
    }
  }
  for (const root of capture.roots) {
    if (root.observed === "present" && !capturedRootIds.has(root.id)) {
      throw new Error(`captured ${decoder.sourceLabel} root ${root.id} lacks a retained root entry`);
    }
  }
  return files.sort((left, right) => compareText(left.entry.logical_path, right.entry.logical_path));
}

export function addLegacyImportCandidate(
  candidates: LegacyImportPendingCandidate[],
  file: LegacyImportDecodedSourceFile,
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
  reasonCode: string,
  start = 0,
  end = file.bytes.length,
  classification: "compare" | "preserve" = "compare",
): void {
  candidates.push({
    classification,
    target,
    raw: rawLegacyImportValue(file, start, end),
    normalized,
    provenance: {
      source_id: file.entry.source_id,
      parser_id: file.parserId,
      parser_version: file.parserVersion,
    },
    reason_code: reasonCode,
  });
}

export function addLegacyImportDiagnosis(
  diagnoses: LegacyImportPendingDiagnosis[],
  file: LegacyImportDecodedSourceFile,
  code: string,
  severity: "info" | "warning" | "blocker",
  message: string,
  disposition: "mapped" | "preserved" | "requires-user" | "unsupported",
  start = 0,
  end = file.bytes.length,
  target?: LegacyImportTarget,
  raw: LegacyImportValue = file.bytes.subarray(start, end).toString("utf8"),
): void {
  const identity = {
    code,
    severity,
    source_id: file.entry.source_id,
    locator: { start_byte: start, end_byte: end, line: lineAtByte(file, start) },
    raw_value: raw,
    message,
  };
  diagnoses.push({
    diagnosis_id: hashLegacyImportValue(identity),
    ...identity,
    resolution: { disposition, ...(target === undefined ? {} : { target }) },
  });
}

function sourceRecord(
  file: LegacyImportDecodedSourceFile,
): LegacyImportPreviewSource {
  return {
    source_id: file.entry.source_id,
    path: file.entry.logical_path,
    kind: file.kind,
    byte_size: file.bytes.length,
    sha256: file.entry.sha256!,
    parser_id: file.parserId,
    parser_version: file.parserVersion,
    encoding: file.encoding,
    outcome: file.outcome,
  };
}

export function finalizeLegacyImportInterpretation(
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
  completeRowSets: readonly LegacyImportPendingCompleteRowSet[] = [],
): LegacyImportInterpretation {
  const orderedPending = [...candidates].sort((left, right) => compareText(
    canonicalLegacyImportJson(candidateOrderValue(left)),
    canonicalLegacyImportJson(candidateOrderValue(right)),
  ));
  const finalizedCandidates = orderedPending.map((candidate, index): LegacyImportInterpretationCandidate => ({
    candidate_id: hashLegacyImportValue(candidate),
    ordinal: index + 1,
    ...candidate,
  }));
  const orderedDiagnoses = [...diagnoses].sort((left, right) => {
    const { resolution: _leftResolution, ...leftValue } = left;
    const { resolution: _rightResolution, ...rightValue } = right;
    return compareText(canonicalLegacyImportJson(leftValue), canonicalLegacyImportJson(rightValue));
  });
  const finalizedDiagnoses = orderedDiagnoses.map(({ resolution: _resolution, ...diagnosis }) => diagnosis);
  const resolutions = orderedDiagnoses.map((diagnosis): LegacyImportPreviewResolution => ({
    diagnosis_id: diagnosis.diagnosis_id,
    ...diagnosis.resolution,
  }));
  return deepFreeze({
    sources: files.map(sourceRecord),
    candidates: finalizedCandidates,
    complete_row_sets: finalizeCompleteRowSets(completeRowSets),
    diagnoses: finalizedDiagnoses,
    resolutions,
  });
}
