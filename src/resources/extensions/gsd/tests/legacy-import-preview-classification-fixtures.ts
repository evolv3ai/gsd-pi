// Project/App: gsd-pi
// File Purpose: Shared deterministic fixtures for legacy Preview classification tests.

import assert from "node:assert/strict";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  type LegacyImportPreviewDiagnosis,
  type LegacyImportPreviewResolution,
  type LegacyImportPreviewSource,
  type LegacyImportRawValue,
  type LegacyImportTarget,
  type LegacyImportValue,
} from "../legacy-import-contract.ts";
import type {
  LegacyImportBaseRow,
  LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import type { LegacyImportClassification } from "../legacy-import-preview-classifier.ts";
import type {
  LegacyImportCompleteRowSet,
  LegacyImportInterpretation,
  LegacyImportInterpretationCandidate,
} from "../legacy-import-preview-interpretation.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
} from "../legacy-import-preview.ts";

export function classificationSource(
  sourceId: string,
  path: string,
  outcome: LegacyImportPreviewSource["outcome"] = "mapped",
): LegacyImportPreviewSource {
  return {
    source_id: sourceId,
    path,
    kind: path.endsWith(".json") ? "json" : "markdown",
    byte_size: 128,
    sha256: hashLegacyImportValue([sourceId, path]),
    parser_id: `parser-${sourceId}`,
    parser_version: "1",
    encoding: "utf-8",
    outcome,
  };
}

export function classificationRaw(
  sourceId: string,
  value: LegacyImportValue,
  jsonPointer: string,
): LegacyImportRawValue {
  return {
    source_id: sourceId,
    locator: { start_byte: 12, end_byte: 96, line: 2, json_pointer: jsonPointer },
    value,
    sha256: hashLegacyImportValue(value),
  };
}

export function classificationCandidate(
  source: LegacyImportPreviewSource,
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
  options: {
    classification?: "compare" | "preserve";
    jsonPointer?: string;
    ordinal?: number;
    reasonCode?: string;
    raw?: LegacyImportRawValue;
  } = {},
): LegacyImportInterpretationCandidate {
  const pending = {
    classification: options.classification ?? "compare",
    target,
    raw: options.raw ?? classificationRaw(
      source.source_id,
      normalized,
      options.jsonPointer ?? "/candidate",
    ),
    normalized,
    provenance: {
      source_id: source.source_id,
      parser_id: source.parser_id,
      parser_version: source.parser_version,
    },
    reason_code: options.reasonCode ?? "fixture-candidate",
  } as const;
  return {
    candidate_id: hashLegacyImportValue(pending),
    ordinal: options.ordinal ?? 1,
    ...pending,
  };
}

export function classificationBaseRow(
  rowSet: LegacyImportBaseRow["row_set"],
  identity: Readonly<Record<string, LegacyImportValue>>,
  value: Readonly<Record<string, LegacyImportValue>>,
): LegacyImportBaseRow {
  return { row_set: rowSet, identity: canonicalLegacyImportJson(identity), value };
}

export function classificationBase(
  rows: readonly LegacyImportBaseRow[] = [],
): LegacyImportBaseSnapshot {
  return {
    snapshot_schema_version: 1,
    database_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
    authority: {
      singleton: 1,
      project_id: "project-test",
      project_root_realpath: "/repo",
      revision: 17,
      authority_epoch: 2,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    rows,
    relevant_rows_hash: hashLegacyImportValue(rows),
  };
}

export function classificationInterpretation(
  sources: readonly LegacyImportPreviewSource[],
  candidates: readonly LegacyImportInterpretationCandidate[],
  completeRowSets: readonly LegacyImportCompleteRowSet[] = [],
  diagnoses: readonly LegacyImportPreviewDiagnosis[] = [],
  resolutions: readonly LegacyImportPreviewResolution[] = [],
): LegacyImportInterpretation {
  return {
    sources,
    candidates,
    complete_row_sets: completeRowSets,
    diagnoses,
    resolutions,
  };
}

export function classificationDecision(
  id: string,
  choice: string,
  seq?: number,
): Readonly<Record<string, LegacyImportValue>> {
  return {
    ...(seq === undefined ? {} : { seq }),
    id,
    when_context: "During import",
    scope: "global",
    decision: `Choose ${id}`,
    choice,
    rationale: "Keep one authority.",
    revisable: "yes",
    made_by: "human",
    source: "discussion",
    superseded_by: null,
  };
}

export function classificationCompleteDecisions(
  source: LegacyImportPreviewSource,
  values: readonly Readonly<Record<string, LegacyImportValue>>[],
  memberKeys = values.map((value) => String(value.id)),
): LegacyImportCompleteRowSet {
  const pending = {
    row_set: "decisions" as const,
    target_kind: "decision",
    member_keys: memberKeys,
    raw: classificationRaw(source.source_id, values, "/decisions"),
    provenance: {
      source_id: source.source_id,
      parser_id: source.parser_id,
      parser_version: source.parser_version,
    },
  };
  return { complete_set_id: hashLegacyImportValue(pending), ...pending };
}

export function assertStableClassificationHashes(result: LegacyImportClassification): void {
  assert.equal(result.source_set_hash, hashLegacyImportValue(result.sources));
  assert.equal(result.change_set_hash, hashLegacyImportValue(result.changes));
  for (const change of result.changes) {
    const { change_id: _changeId, ...pending } = change;
    assert.equal(change.change_id, hashLegacyImportValue(pending));
  }
}
