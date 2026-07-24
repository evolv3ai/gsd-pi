// Project/App: gsd-pi
// File Purpose: Unified captured-byte interpretation for supplemental legacy GSD evidence.

import {
  contributeLegacyImportDatabaseTargets,
  type LegacyImportDatabaseTargetInspectionEvidence,
} from "./legacy-import-preview-database-target.js";
import { interpretLegacyGsdHistory } from "./legacy-import-preview-gsd-history.js";
import { interpretLegacyGsdWorkflows } from "./legacy-import-preview-gsd-workflows.js";
import {
  decodeLegacyImportCapture,
  finalizeLegacyImportInterpretation,
  type LegacyImportDecodedSourceFile,
  type LegacyImportInterpretation,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";
import { contributeLegacyKnowledgeProjection } from "./legacy-import-preview-knowledge.js";
import { contributeLegacyRootProjections } from "./legacy-import-preview-root.js";
import type { LegacyImportSourceCapture } from "./legacy-import-preview-source.js";
import { contributeLegacyWorktreeTopology } from "./legacy-import-preview-worktree.js";

const UNCLAIMED_PARSER_ID = "supplemental-unclaimed";
const EMPTY_DATABASE_EVIDENCE: readonly LegacyImportDatabaseTargetInspectionEvidence[] = Object.freeze([]);
const EMPTY_DEFINITION_NAMES: readonly string[] = Object.freeze([]);

export interface LegacyImportSupplementalContext {
  databaseTargetEvidence?: readonly LegacyImportDatabaseTargetInspectionEvidence[];
  bundledDefinitionNames?: readonly string[];
}

export function contributeLegacySupplementalFiles(
  capture: LegacyImportSourceCapture,
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
  context: LegacyImportSupplementalContext = {},
): void {
  contributeLegacyImportDatabaseTargets(
    capture,
    files,
    context.databaseTargetEvidence ?? EMPTY_DATABASE_EVIDENCE,
    diagnoses,
  );
  contributeLegacyWorktreeTopology(files, candidates, diagnoses, capture);
  interpretLegacyGsdHistory(files, candidates, diagnoses);
  interpretLegacyGsdWorkflows(files, candidates, diagnoses, {
    bundledDefinitionNames: context.bundledDefinitionNames ?? EMPTY_DEFINITION_NAMES,
  });
  contributeLegacyKnowledgeProjection(files, candidates, diagnoses);
  contributeLegacyRootProjections(files, candidates);
}

export function interpretLegacySupplementalCapture(
  capture: LegacyImportSourceCapture,
  context: LegacyImportSupplementalContext = {},
): LegacyImportInterpretation {
  const files = decodeLegacyImportCapture(capture, {
    sourceLabel: "supplemental GSD",
    includes: (entry) => entry.kind !== "directory",
    parserId: () => UNCLAIMED_PARSER_ID,
    kind: () => "unclassified",
    parserVersion: "1",
  });
  const candidates: LegacyImportPendingCandidate[] = [];
  const diagnoses: LegacyImportPendingDiagnosis[] = [];
  contributeLegacySupplementalFiles(capture, files, candidates, diagnoses, context);
  const unclaimed = files.filter((file) => file.parserId === UNCLAIMED_PARSER_ID);
  if (unclaimed.length > 0) {
    throw new Error(`captured supplemental GSD sources are unclaimed: ${unclaimed.map((file) => file.entry.logical_path).join(", ")}`);
  }
  return finalizeLegacyImportInterpretation(files, candidates, diagnoses);
}
