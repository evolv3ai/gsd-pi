// Project/App: gsd-pi
// File Purpose: Pure captured-byte interpretation contract for legacy .gsd truth.

import type {
  LegacyImportLocator,
  LegacyImportSha256,
  LegacyImportValue,
} from "./legacy-import-contract.js";
import {
  addLegacyImportDiagnosis,
  decodeLegacyImportCapture,
  finalizeLegacyImportInterpretation,
  type LegacyImportDecodedSourceFile,
  type LegacyImportInterpretation,
  type LegacyImportInterpretationCandidate,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingCompleteRowSet,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";
import type { LegacyImportSourceCapture } from "./legacy-import-preview-source.js";
import { hashLegacyImportBytes, hashLegacyImportValue } from "./legacy-import-preview.js";
import {
  hasModeledLegacyGsdAssessmentSource,
  interpretLegacyGsdAssessments,
  validateLegacyGsdAssessmentManifest,
} from "./legacy-import-preview-gsd-assessments.js";
import {
  hasModeledLegacyGsdHierarchySource,
  interpretLegacyGsdHierarchyFiles,
} from "./legacy-import-preview-gsd-hierarchy.js";
import {
  hasModeledLegacyGsdLifecycleSource,
  interpretLegacyGsdLifecycle,
  type LegacyImportDelegatedHierarchyMembers,
  validateLegacyGsdLifecycleManifest,
} from "./legacy-import-preview-gsd-lifecycle.js";
import { interpretLegacyGsdRegistries } from "./legacy-import-preview-gsd-registries.js";
import { parseLegacyImportJson } from "./legacy-import-preview-json.js";

export interface LegacyImportGsdDatabaseObservation {
  table: "slices" | "slice_dependencies";
  key: Readonly<Record<string, string>>;
  field: string;
  value: LegacyImportValue;
  raw: {
    locator: LegacyImportLocator;
    value: string;
    sha256: LegacyImportSha256;
  };
}

export interface LegacyImportGsdDatabaseEvidence {
  evidence_version: 1;
  inspection_version: 1;
  capture_hash: LegacyImportSha256;
  source_id: LegacyImportSha256;
  source_sha256: LegacyImportSha256;
  source_byte_size: number;
  coverage: readonly {
    table: "slices" | "slice_dependencies";
    field: "depends" | "depends_on_slice_id";
    complete: true;
    row_count: number;
  }[];
  observations: readonly LegacyImportGsdDatabaseObservation[];
  evidence_hash: LegacyImportSha256;
}

export type LegacyImportGsdCandidate = LegacyImportInterpretationCandidate;
export type LegacyImportGsdInterpretation = LegacyImportInterpretation;

const EMPTY: readonly LegacyImportGsdDatabaseEvidence[] = Object.freeze([]);

function parserId(path: string): string {
  const lower = path.toLowerCase();
  if (lower === ".gsd/decisions.md") return "gsd-decisions-table";
  if (lower === ".gsd/requirements.md") return "gsd-requirements-sections";
  if (lower === ".gsd/gsd.db") return "gsd-sqlite-target";
  if (lower === ".gsd/state-manifest.json") return "gsd-lifecycle-truth";
  return "gsd-artifact-classifier";
}

function sourceKind(path: string): string {
  const lower = path.toLowerCase();
  if (lower === ".gsd/gsd.db") return "sqlite-database";
  if (lower.endsWith(".json")) return "json";
  return "markdown";
}

function validateDatabaseEvidence(
  capture: LegacyImportSourceCapture,
  files: readonly LegacyImportDecodedSourceFile[],
  evidenceSet: readonly LegacyImportGsdDatabaseEvidence[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  const bySource = new Map(files.map((file) => [file.entry.source_id, file]));
  const seen = new Set<string>();
  for (const evidence of evidenceSet) {
    const { evidence_hash: evidenceHash, ...evidenceValue } = evidence;
    if (
      evidence.evidence_version !== 1
      || evidence.inspection_version !== 1
      || evidence.capture_hash !== capture.capture_hash
      || hashLegacyImportValue(evidenceValue) !== evidenceHash
    ) {
      throw new Error("legacy GSD database evidence identity is inconsistent");
    }
    const file = bySource.get(evidence.source_id);
    if (
      file === undefined
      || file.entry.logical_path.toLowerCase() !== ".gsd/gsd.db"
      || file.entry.kind !== "file"
      || evidence.source_sha256 !== file.entry.sha256
      || evidence.source_byte_size !== file.bytes.length
      || seen.has(evidence.source_id)
    ) {
      throw new Error("legacy GSD database evidence source is inconsistent");
    }
    seen.add(evidence.source_id);
    const expectedCoverage = ["slice_dependencies\0depends_on_slice_id", "slices\0depends"];
    const actualCoverage = evidence.coverage.map((coverage) => {
      if (
        coverage.complete !== true
        || !Number.isSafeInteger(coverage.row_count)
        || coverage.row_count < 0
      ) {
        throw new Error("legacy GSD database evidence coverage is incomplete");
      }
      return `${coverage.table}\0${coverage.field}`;
    }).sort();
    if (actualCoverage.length !== 2 || actualCoverage.some((value, index) => value !== expectedCoverage[index])) {
      throw new Error("legacy GSD database evidence coverage is incomplete");
    }
    const observationCounts = new Map<string, number>();
    const observationIdentities = new Set<string>();
    const observationSpans: Array<{ start: number; end: number }> = [];
    for (const observation of evidence.observations) {
      const { start_byte: start, end_byte: end } = observation.raw.locator;
      if (
        (observation.table !== "slices" && observation.table !== "slice_dependencies")
        || (observation.table === "slices" && (
          observation.field !== "depends"
          || Object.keys(observation.key).length !== 2
          || !("id" in observation.key)
          || !("milestone_id" in observation.key)
        ))
        || (observation.table === "slice_dependencies" && (
          observation.field !== "depends_on_slice_id"
          || Object.keys(observation.key).length !== 2
          || !("milestone_id" in observation.key)
          || !("slice_id" in observation.key)
        ))
        || Object.values(observation.key).some((value) => typeof value !== "string" || value.length === 0)
        || typeof observation.field !== "string"
        || observation.field.length === 0
        || !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || end === undefined
        || start < 0
        || end <= start
        || end > file.bytes.length
      ) {
        throw new Error("legacy GSD database evidence span is inconsistent");
      }
      const bytes = file.bytes.subarray(start, end);
      let rawValue: LegacyImportValue = observation.raw.value;
      if (observation.table === "slices") {
        try {
          rawValue = JSON.parse(observation.raw.value) as LegacyImportValue;
        } catch {
          throw new Error("legacy GSD database evidence span is inconsistent");
        }
      }
      if (
        (observation.table === "slices" && (
          !Array.isArray(observation.value)
          || observation.value.some((value) => typeof value !== "string" || value.length === 0)
        ))
        || (observation.table === "slice_dependencies" && (
          typeof observation.value !== "string" || observation.value.length === 0
        ))
      ) {
        throw new Error("legacy GSD database evidence value is inconsistent");
      }
      const observationIdentity = hashLegacyImportValue([
        observation.table,
        observation.key,
        observation.field,
      ]);
      if (
        observationIdentities.has(observationIdentity)
        || observationSpans.some((span) => start < span.end && end > span.start)
      ) {
        throw new Error("legacy GSD database evidence observations are duplicated");
      }
      observationIdentities.add(observationIdentity);
      observationSpans.push({ start, end });
      if (
        bytes.toString("utf8") !== observation.raw.value
        || hashLegacyImportBytes(bytes) !== observation.raw.sha256
        || hashLegacyImportValue(rawValue) !== hashLegacyImportValue(observation.value)
      ) {
        throw new Error("legacy GSD database evidence span is inconsistent");
      }
      const coverageKey = `${observation.table}\0${observation.field}`;
      observationCounts.set(coverageKey, (observationCounts.get(coverageKey) ?? 0) + 1);
    }
    for (const coverage of evidence.coverage) {
      if ((observationCounts.get(`${coverage.table}\0${coverage.field}`) ?? 0) !== coverage.row_count) {
        throw new Error("legacy GSD database evidence coverage is incomplete");
      }
    }
    file.parserId = "gsd-sqlite-target";
    file.kind = "sqlite-database";
    file.encoding = "binary";
    file.outcome = "mapped";
  }
  for (const file of files) {
    if (file.entry.logical_path.toLowerCase() !== ".gsd/gsd.db" || seen.has(file.entry.source_id)) continue;
    file.parserId = "gsd-sqlite-target";
    file.kind = "sqlite-database";
    file.encoding = "binary";
    file.outcome = "unparsed";
    const supportedFile = file.entry.kind === "file";
    addLegacyImportDiagnosis(
      diagnoses,
      file,
      supportedFile ? "missing-complete-database-evidence" : "unsupported-gsd-database-source",
      "blocker",
      supportedFile
        ? "The captured database requires a complete, capture-bound structured inspection before it can contribute truth."
        : "A legacy GSD database must be a retained regular file before it can be inspected.",
      supportedFile ? "requires-user" : "unsupported",
    );
  }
}

function preserveUnhandledSources(
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.parserId !== "gsd-artifact-classifier" || file.outcome !== "mapped") continue;
    file.outcome = "preserved";
    const target = { kind: "legacy-artifact", key: file.entry.logical_path };
    candidates.push({
      classification: "preserve",
      target,
      raw: {
        source_id: file.entry.source_id,
        locator: { start_byte: 0, end_byte: file.bytes.length, line: 1 },
        value: file.text,
        sha256: hashLegacyImportBytes(file.bytes),
      },
      normalized: { path: file.entry.logical_path, preservation: "verbatim" },
      provenance: { source_id: file.entry.source_id, parser_id: file.parserId, parser_version: file.parserVersion },
      reason_code: "unrecognized-gsd-artifact-preserved",
    });
    addLegacyImportDiagnosis(
      diagnoses, file, "unrecognized-gsd-artifact", "warning",
      "The retained GSD artifact is not modeled and is preserved verbatim.",
      "preserved", 0, file.bytes.length, target,
    );
  }
}

function delegatedHierarchyMembers(
  candidates: readonly LegacyImportPendingCandidate[],
): LegacyImportDelegatedHierarchyMembers {
  const members = {
    milestones: new Set<string>(),
    slices: new Set<string>(),
    tasks: new Set<string>(),
  };
  for (const candidate of candidates) {
    if (candidate.classification !== "compare" || candidate.target.field !== undefined) continue;
    if (candidate.target.kind === "milestone") members.milestones.add(candidate.target.key);
    else if (candidate.target.kind === "slice") members.slices.add(candidate.target.key);
    else if (candidate.target.kind === "task") members.tasks.add(candidate.target.key);
  }
  return {
    milestones: [...members.milestones].sort(),
    slices: [...members.slices].sort(),
    tasks: [...members.tasks].sort(),
  };
}

function hasHierarchyRoadmapPath(files: readonly LegacyImportDecodedSourceFile[]): boolean {
  return files.some((file) => (
    /\/milestones\/[^/]+\/(?:M[^/]+)-ROADMAP\.md$/u.test(file.entry.logical_path)
    || /\/phases\/[^/]+\/(?:M?\d+)-ROADMAP\.md$/u.test(file.entry.logical_path)
  ));
}

function hasIndependentHierarchy(files: readonly LegacyImportDecodedSourceFile[]): boolean {
  if (!hasHierarchyRoadmapPath(files)) return false;
  const manifest = files.find((file) => (
    file.entry.logical_path.toLowerCase() === ".gsd/state-manifest.json" && file.outcome !== "unparsed"
  ));
  if (manifest === undefined) return true;
  const value = parseLegacyImportJson(manifest.bytes).value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  const record = value as Readonly<Record<string, LegacyImportValue>>;
  return (!Array.isArray(record.slices) || record.slices.length === 0)
    && (!Array.isArray(record.tasks) || record.tasks.length === 0);
}

function hasCleanModeledHierarchy(files: readonly LegacyImportDecodedSourceFile[]): boolean {
  const candidates: LegacyImportPendingCandidate[] = [];
  const diagnoses: LegacyImportPendingDiagnosis[] = [];
  interpretLegacyGsdHierarchyFiles(structuredClone(files), candidates, diagnoses);
  return candidates.some((candidate) => (
    candidate.classification === "compare"
    && candidate.target.field === undefined
    && (candidate.target.kind === "milestone" || candidate.target.kind === "slice" || candidate.target.kind === "task")
  )) && !diagnoses.some((diagnosis) => diagnosis.severity === "blocker");
}

function rejectUnsupportedSources(
  files: readonly LegacyImportDecodedSourceFile[],
  diagnoses: LegacyImportPendingDiagnosis[],
  databaseEvidence: readonly LegacyImportGsdDatabaseEvidence[],
): void {
  const evidencedSources = new Set(databaseEvidence.map((evidence) => evidence.source_id));
  for (const file of files) {
    if (evidencedSources.has(file.entry.source_id)) continue;
    if (file.entry.logical_path.toLowerCase() === ".gsd/gsd.db") continue;
    if (file.entry.kind === "symlink") {
      file.kind = "symlink";
      file.outcome = "unparsed";
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "unsupported-gsd-symlink",
        "blocker",
        "Legacy GSD symlink content is retained but never followed or interpreted.",
        "unsupported",
      );
    } else if (file.encoding === "binary") {
      file.outcome = "unparsed";
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "unsupported-gsd-encoding",
        "blocker",
        "Legacy GSD Markdown and JSON must be valid UTF-8.",
        "unsupported",
      );
    }
  }
}

function rejectMalformedManifests(
  files: readonly LegacyImportDecodedSourceFile[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  for (const file of files) {
    if (file.entry.logical_path.toLowerCase() !== ".gsd/state-manifest.json" || file.outcome === "unparsed") continue;
    try {
      parseLegacyImportJson(file.bytes);
    } catch {
      file.outcome = "unparsed";
      addLegacyImportDiagnosis(
        diagnoses,
        file,
        "malformed-state-manifest",
        "blocker",
        "The structured state manifest is malformed and cannot establish lifecycle truth.",
        "requires-user",
      );
    }
  }
}

export function interpretLegacyGsdCapture(
  capture: LegacyImportSourceCapture,
  databaseEvidence: readonly LegacyImportGsdDatabaseEvidence[] = EMPTY,
): LegacyImportGsdInterpretation {
  const files = decodeLegacyImportCapture(capture, {
    sourceLabel: "GSD",
    includes: (entry) => entry.logical_path.startsWith(".gsd/"),
    parserId,
    kind: sourceKind,
    parserVersion: "1",
  });
  const candidates: LegacyImportPendingCandidate[] = [];
  const completeRowSets: LegacyImportPendingCompleteRowSet[] = [];
  const diagnoses: LegacyImportPendingDiagnosis[] = [];
  validateDatabaseEvidence(capture, files, databaseEvidence, diagnoses);
  rejectUnsupportedSources(files, diagnoses, databaseEvidence);
  rejectMalformedManifests(files, diagnoses);
  const hierarchyCandidates: LegacyImportPendingCandidate[] = [];
  if (hasIndependentHierarchy(files) || hasCleanModeledHierarchy(files)) {
    interpretLegacyGsdHierarchyFiles(files, hierarchyCandidates, diagnoses);
  }
  const delegatedHierarchy = delegatedHierarchyMembers(hierarchyCandidates);
  const delegateAssessments = hasModeledLegacyGsdAssessmentSource(files);
  const hasExternalHierarchyReferences = hasModeledLegacyGsdHierarchySource(files)
    || hasModeledLegacyGsdLifecycleSource(files)
    || delegateAssessments;
  candidates.push(...hierarchyCandidates);
  validateLegacyGsdLifecycleManifest(
    files,
    diagnoses,
    delegatedHierarchy,
    hasExternalHierarchyReferences,
    delegateAssessments,
  );
  validateLegacyGsdAssessmentManifest(files, diagnoses);
  interpretLegacyGsdLifecycle(
    files,
    databaseEvidence,
    candidates,
    diagnoses,
    completeRowSets,
    delegatedHierarchy,
    hasExternalHierarchyReferences,
    delegateAssessments,
  );
  interpretLegacyGsdAssessments(files, candidates, diagnoses, !delegateAssessments);
  interpretLegacyGsdRegistries(files, candidates, diagnoses);
  preserveUnhandledSources(files, candidates, diagnoses);
  return finalizeLegacyImportInterpretation(files, candidates, diagnoses, completeRowSets);
}
