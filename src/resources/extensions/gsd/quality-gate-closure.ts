// Project/App: gsd-pi
// File Purpose: Canonical quality-gate closure from durable DB and artifact evidence.

import { existsSync, readFileSync } from "node:fs";

import { extractSection } from "./files.js";
import { getGateDefinition } from "./gate-registry.js";
import { getMilestoneSlices, getPendingGates, saveGateResult } from "./gsd-db.js";
import { resolveSliceFile, resolveTaskFile } from "./paths.js";
import type { GateId, GateRow, GateVerdict } from "./types.js";

export interface QualityGateClosureOptions {
  artifactBasePath?: string;
  milestoneValidationPassed?: boolean;
}

export interface QualityGateClosureResult {
  repaired: Array<{ gateId: GateId; sliceId: string; taskId?: string; verdict: GateVerdict }>;
  unresolved: GateRow[];
}

interface GateEvidence {
  verdict: GateVerdict;
  rationale: string;
  findings: string;
}

const GATE_SECTION_HEADINGS: Partial<Record<GateId, string[]>> = {
  Q3: ["Threat Surface", "Abuse Surface"],
  Q4: ["Requirement Impact", "Broken Promises"],
  Q5: ["Failure Modes"],
  Q6: ["Load Profile"],
  Q7: ["Negative Tests"],
  Q8: ["Operational Readiness"],
};

function readFile(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

function firstSection(content: string | null, gateId: GateId): string | null {
  if (!content) return null;
  for (const heading of GATE_SECTION_HEADINGS[gateId] ?? []) {
    const section = extractSection(content, heading);
    if (section) return section;
  }
  return null;
}

function evidenceArtifactContent(row: GateRow, basePath: string): string | null {
  const def = getGateDefinition(row.gate_id);
  switch (def?.ownerTurn) {
    case "gate-evaluate":
      return readFile(resolveSliceFile(basePath, row.milestone_id, row.slice_id, "PLAN"));
    case "execute-task":
      return readFile(resolveTaskFile(basePath, row.milestone_id, row.slice_id, row.task_id, "SUMMARY"));
    case "complete-slice":
      return readFile(resolveSliceFile(basePath, row.milestone_id, row.slice_id, "SUMMARY"));
    default:
      return null;
  }
}

function closureEvidence(row: GateRow, options: QualityGateClosureOptions): GateEvidence | null {
  const def = getGateDefinition(row.gate_id);
  if (!def) return null;

  if (def.ownerTurn === "validate-milestone" && options.milestoneValidationPassed) {
    return {
      verdict: "pass",
      rationale: `${def.promptSection} covered by passing milestone validation`,
      findings: "",
    };
  }

  if (!options.artifactBasePath) return null;

  const section = firstSection(evidenceArtifactContent(row, options.artifactBasePath), row.gate_id);
  if (section) {
    return {
      verdict: "pass",
      rationale: `${def.promptSection} evidence found in durable artifact`,
      findings: section,
    };
  }

  if (!options.milestoneValidationPassed) return null;
  return {
    verdict: "omitted",
    rationale: `${def.promptSection} has no durable artifact section; milestone validation passed`,
    findings: "",
  };
}

function closeGate(row: GateRow, evidence: GateEvidence): void {
  saveGateResult({
    milestoneId: row.milestone_id,
    sliceId: row.slice_id,
    gateId: row.gate_id,
    taskId: row.task_id,
    verdict: evidence.verdict,
    rationale: evidence.rationale,
    findings: evidence.findings,
  });
}

export function closeQualityGatesFromEvidence(
  milestoneId: string,
  options: QualityGateClosureOptions = {},
): QualityGateClosureResult {
  const repaired: QualityGateClosureResult["repaired"] = [];
  const unresolved: GateRow[] = [];

  for (const slice of getMilestoneSlices(milestoneId)) {
    const sliceId = slice.id;
    for (const row of getPendingGates(milestoneId, sliceId)) {
      if (!getGateDefinition(row.gate_id)) {
        unresolved.push(row);
        continue;
      }

      const evidence = closureEvidence(row, options);
      if (!evidence) {
        unresolved.push(row);
        continue;
      }

      closeGate(row, evidence);
      repaired.push({
        gateId: row.gate_id,
        sliceId: row.slice_id,
        ...(row.task_id ? { taskId: row.task_id } : {}),
        verdict: evidence.verdict,
      });
    }
  }

  return { repaired, unresolved };
}
