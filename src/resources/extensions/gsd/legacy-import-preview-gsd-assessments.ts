// Project/App: gsd-pi
// File Purpose: Pure assessment and validation truth interpretation from retained .gsd bytes.

import type { LegacyImportTarget, LegacyImportValue } from "./legacy-import-contract.js";
import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "./legacy-import-preview-interpretation.js";
import { parseLegacyImportJson, type LegacyImportJsonDocument } from "./legacy-import-preview-json.js";
import { hashLegacyImportBytes } from "./legacy-import-preview.js";

interface ManifestAssessment {
  milestone_id: string;
  slice_id: string | null;
  status: string;
  scope: string;
  full_content: string;
}

interface AssessmentManifest {
  file: LegacyImportDecodedSourceFile;
  document: LegacyImportJsonDocument;
  assessments: readonly ManifestAssessment[];
  versioned: boolean;
}

interface ArtifactVerdict {
  file: LegacyImportDecodedSourceFile;
  milestone: string;
  slice?: string;
  role: "assessment" | "uat" | "validation" | "roadmap" | "backfill";
  verdict: string | null;
  start: number;
  end: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedStatus(status: string): string {
  return status === "passed" ? "pass" : status;
}

function artifactVerdictError(value: ArtifactVerdict): string | undefined {
  if (value.verdict === null) {
    return value.file.text.includes("Verdict:")
      ? "malformed-assessment-verdict"
      : "missing-assessment-verdict";
  }
  if (value.verdict === "partial") {
    const hasPass = value.file.lines.some((line) => /^-\s*PASS:/u.test(line.text));
    const hasFail = value.file.lines.some((line) => /^-\s*FAIL:/u.test(line.text));
    return hasPass && hasFail ? undefined : "invalid-partial-verdict";
  }
  return value.verdict === "pass" || value.verdict === "fail"
    ? undefined
    : "malformed-assessment-verdict";
}

function readAssessmentManifest(
  file: LegacyImportDecodedSourceFile,
  diagnoses: LegacyImportPendingDiagnosis[],
): AssessmentManifest | undefined {
  if (file.entry.logical_path.toLowerCase() !== ".gsd/state-manifest.json" || file.outcome === "unparsed") return undefined;
  const document = parseLegacyImportJson(file.bytes);
  if (!isRecord(document.value) || !("assessments" in document.value)) return undefined;
  const raw = document.value.assessments;
  const seen = new Set<string>();
  const assessments: ManifestAssessment[] = [];
  let valid = Array.isArray(raw);
  if (Array.isArray(raw)) {
    for (const candidate of raw) {
      if (
        !isRecord(candidate)
        || typeof candidate.milestone_id !== "string"
        || !/^M\d+(?:-[a-z0-9]+)?$/u.test(candidate.milestone_id)
        || !(candidate.slice_id === null || (
          typeof candidate.slice_id === "string" && /^S\d+$/u.test(candidate.slice_id)
        ))
        || typeof candidate.status !== "string"
        || !["pass", "passed", "fail", "partial", "needs-attention"].includes(candidate.status)
        || (candidate.scope !== "run-uat" && candidate.scope !== "milestone-validation")
        || typeof candidate.full_content !== "string"
      ) {
        valid = false;
        continue;
      }
      const assessment = candidate as unknown as ManifestAssessment;
      const identity = `${assessment.milestone_id}\0${assessment.slice_id ?? ""}\0${assessment.scope}`;
      if (seen.has(identity)) {
        valid = false;
        continue;
      }
      seen.add(identity);
      assessments.push(assessment);
    }
  }
  if (file.parserId !== "gsd-lifecycle-truth") file.parserId = "gsd-assessment-truth";
  file.kind = "json";
  if (!valid) {
    file.outcome = "unparsed";
    addLegacyImportDiagnosis(
      diagnoses, file, "invalid-assessment-manifest", "blocker",
      "The structured assessment manifest has an unsupported, duplicate, or malformed assessment entry.",
      "requires-user",
    );
    return { file, document, assessments: [], versioned: document.value.version === 1 };
  }
  file.outcome = "mapped";
  return { file, document, assessments, versioned: document.value.version === 1 };
}

export function validateLegacyGsdAssessmentManifest(
  files: readonly LegacyImportDecodedSourceFile[],
  diagnoses: LegacyImportPendingDiagnosis[],
): void {
  const file = files.find((candidate) => (
    candidate.entry.logical_path.toLowerCase() === ".gsd/state-manifest.json"
  ));
  if (file !== undefined) readAssessmentManifest(file, diagnoses);
}

function byteLine(file: LegacyImportDecodedSourceFile, start: number): number {
  return file.bytes.subarray(0, start).reduce((line, byte) => line + (byte === 10 ? 1 : 0), 1);
}

function addManifestCandidate(
  candidates: LegacyImportPendingCandidate[],
  file: LegacyImportDecodedSourceFile,
  document: LegacyImportJsonDocument,
  assessment: ManifestAssessment,
  index: number,
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
  reasonCode: string,
): void {
  const token = document.locate(`/assessments/${index}/status`);
  const start = token.start_byte;
  const end = token.end_byte;
  candidates.push({
    classification: target.kind.startsWith("legacy-") ? "preserve" : "compare",
    target,
    raw: {
      source_id: file.entry.source_id,
      locator: { start_byte: start, end_byte: end, line: byteLine(file, start), json_pointer: token.json_pointer },
      value: token.value,
      sha256: hashLegacyImportBytes(file.bytes.subarray(start, end)),
    },
    normalized,
    provenance: { source_id: file.entry.source_id, parser_id: file.parserId, parser_version: file.parserVersion },
    reason_code: reasonCode,
  });
}

function artifact(file: LegacyImportDecodedSourceFile): ArtifactVerdict | undefined {
  const path = file.entry.logical_path;
  const milestone = path.match(/\/milestones\/(M\d+)/u)?.[1];
  if (milestone === undefined) return undefined;
  const slice = path.match(/\/slices\/(S\d+)/u)?.[1];
  let role: ArtifactVerdict["role"];
  if (/-ROADMAP-ASSESSMENT\.md$/iu.test(path)) role = "roadmap";
  else if (/-BACKFILL-ASSESSMENT\.md$/iu.test(path)) role = "backfill";
  else if (/-VALIDATION\.md$/iu.test(path)) role = "validation";
  else if (/-ASSESSMENT\.md$/iu.test(path)) role = "assessment";
  else if (/-UAT\.md$/iu.test(path)) role = "uat";
  else return undefined;
  const verdictLine = file.lines.find((line) => /^\*\*Verdict:\*\*/iu.test(line.text));
  if (verdictLine !== undefined) {
    return {
      file, milestone, ...(slice === undefined ? {} : { slice }), role,
      verdict: verdictLine.text.match(/^\*\*Verdict:\*\*\s*([^\s]+)/iu)?.[1]?.toLowerCase() ?? null,
      start: verdictLine.start,
      end: verdictLine.end,
    };
  }
  const evidence = file.lines.find((line) => line.text.trim().length > 0 && !line.text.startsWith("#"));
  return {
    file, milestone, ...(slice === undefined ? {} : { slice }), role, verdict: null,
    start: evidence?.start ?? 0,
    end: evidence?.end ?? file.bytes.length,
  };
}

export function hasModeledLegacyGsdAssessmentSource(
  files: readonly LegacyImportDecodedSourceFile[],
): boolean {
  return files.some((file) => (
    file.encoding === "utf-8" && file.outcome !== "unparsed" && artifact(file) !== undefined
  ));
}

function preserveArtifact(
  candidates: LegacyImportPendingCandidate[],
  value: ArtifactVerdict,
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
  reasonCode: string,
): void {
  addLegacyImportCandidate(
    candidates, value.file, target, normalized, reasonCode, value.start, value.end, "preserve",
  );
}

export function interpretLegacyGsdAssessments(
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
  diagnoses: LegacyImportPendingDiagnosis[],
  versionedRowsOwnedByLifecycle = false,
): void {
  const manifestFile = files.find((file) => file.entry.logical_path.toLowerCase() === ".gsd/state-manifest.json");
  const manifest = manifestFile === undefined ? undefined : readAssessmentManifest(manifestFile, diagnoses);
  const artifacts = files.map(artifact).filter((value): value is ArtifactVerdict => value !== undefined);
  if (manifest === undefined && artifacts.length === 0) return;

  const structured = new Map<string, ManifestAssessment>();
  for (const assessment of manifest?.assessments ?? []) {
    structured.set(`${assessment.milestone_id}/${assessment.slice_id ?? ""}/${assessment.scope}`, assessment);
  }

  for (const value of artifacts) {
    const { file, milestone, slice, role, verdict } = value;
    file.parserId = role === "roadmap" || role === "backfill" ? "gsd-artifact-classifier" : "gsd-assessment-truth";
    file.outcome = "preserved";
    if (role === "roadmap" || role === "backfill") {
      const backfill = role === "backfill";
      const target = {
        kind: "legacy-artifact",
        key: backfill ? `${milestone}/${slice}/backfill-assessment` : `${milestone}/roadmap-assessment`,
      };
      const code = backfill ? "fabricated-backfill-placeholder-not-uat" : "roadmap-assessment-not-uat";
      preserveArtifact(candidates, value, target, {
        verdict, authority: backfill ? "artifact-only" : "planning-only",
      }, code);
      addLegacyImportDiagnosis(
        diagnoses, file, code, "warning",
        backfill
          ? "A fabricated backfill placeholder cannot satisfy slice UAT."
          : "Roadmap reassessment cannot satisfy slice UAT.",
        "preserved", value.start, value.end, target,
      );
      continue;
    }
    if (role === "validation") {
      const target = { kind: "legacy-artifact", key: `${milestone}/file-only-validation` };
      preserveArtifact(candidates, value, target, { verdict, authority: "artifact-only" }, "file-validation-not-authority");
      addLegacyImportDiagnosis(
        diagnoses, file, "file-validation-not-authority", "warning",
        "A validation file is projection evidence and cannot replace structured milestone validation.",
        "preserved", value.start, value.end, target,
      );
      const authoritative = structured.get(`${milestone}//milestone-validation`);
      if (authoritative !== undefined && normalizedStatus(authoritative.status) !== verdict) {
        addLegacyImportDiagnosis(
          diagnoses, file, "structured-milestone-validation-vs-artifact-conflict", "blocker",
          "The validation artifact conflicts with structured milestone validation.",
          "requires-user", value.start, value.end,
        );
      }
      continue;
    }
    const target = { kind: "legacy-artifact", key: `${milestone}/${slice}/${role}-artifact` };
    const code = artifactVerdictError(value);
    if (code !== undefined) {
      file.outcome = "unparsed";
      preserveArtifact(candidates, value, target, { verdict: null, authority: "artifact-only" }, code);
      addLegacyImportDiagnosis(
        diagnoses, file, code, "blocker",
        code === "invalid-partial-verdict"
          ? "PARTIAL requires mixed passing and failing results."
          : code === "malformed-assessment-verdict"
            ? "The assessment verdict token is not supported."
            : "The assessment artifact has no verdict.",
        "requires-user", value.start, value.end,
      );
      continue;
    }
    const precedence = role === "assessment" ? 1 : 2;
    preserveArtifact(
      candidates, value, target,
      { verdict, authority: "artifact-only", precedence },
      role === "assessment" ? "assessment-artifact-not-structured-authority" : "uat-artifact-secondary-to-assessment",
    );
    const structuredAssessment = structured.get(`${milestone}/${slice}/run-uat`);
    if (role === "assessment" && structuredAssessment !== undefined && normalizedStatus(structuredAssessment.status) !== verdict) {
      addLegacyImportDiagnosis(
        diagnoses, file, "structured-assessment-vs-artifact-conflict", "blocker",
        "The assessment artifact conflicts with the structured run-UAT verdict.",
        "requires-user", value.start, value.end,
      );
    }
    if (role === "uat") {
      const preferred = artifacts.find((candidate) => (
        candidate.role === "assessment" && candidate.milestone === milestone && candidate.slice === slice
      ));
      if (preferred !== undefined && preferred.verdict !== verdict) {
        addLegacyImportDiagnosis(
          diagnoses, file, "uat-vs-assessment-conflict", "blocker",
          "The UAT artifact conflicts with the preferred assessment artifact.",
          "requires-user", value.start, value.end,
        );
      }
    }
  }

  for (const [index, assessment] of (manifest?.assessments ?? []).entries()) {
    if (manifest?.versioned === true && versionedRowsOwnedByLifecycle) continue;
    const key = assessment.slice_id === null
      ? `${assessment.milestone_id}/${assessment.scope}`
      : `${assessment.milestone_id}/${assessment.slice_id}/${assessment.scope}`;
    const artifactConflict = artifacts.some((candidate) => (
      candidate.milestone === assessment.milestone_id
      && (candidate.slice ?? null) === assessment.slice_id
      && ((assessment.scope === "run-uat" && candidate.role === "assessment")
        || (assessment.scope === "milestone-validation" && candidate.role === "validation"))
      && candidate.verdict !== normalizedStatus(assessment.status)
    ));
    const normalizedVerdict = normalizedStatus(assessment.status);
    if (artifactConflict) {
      addManifestCandidate(
        candidates, manifest!.file, manifest!.document, assessment, index,
        { kind: "legacy-evidence", key: `${key.replace(`/${assessment.scope}`, "")}/structured-${assessment.scope}-evidence` },
        {
          scope: assessment.scope,
          verdict: normalizedVerdict,
          authority: "structured",
          ...(assessment.scope === "run-uat" ? { conflicted: true } : {}),
        },
        assessment.scope === "run-uat" ? "structured-run-uat" : "structured-conflict-evidence",
      );
      continue;
    }
    addManifestCandidate(
      candidates, manifest!.file, manifest!.document, assessment, index,
      { kind: "assessment", key },
      {
        scope: assessment.scope,
        verdict: normalizedVerdict,
        authority: "structured",
        ...(assessment.status === "passed" ? { legacy_verdict: "passed" } : {}),
        ...(assessment.status === "partial" && /pass/iu.test(assessment.full_content) && /fail/iu.test(assessment.full_content)
          ? { result_shape: "mixed" }
          : {}),
      },
      assessment.status === "passed" ? "legacy-passed-normalized-to-pass" : `structured-${assessment.scope}`,
    );
  }
}
