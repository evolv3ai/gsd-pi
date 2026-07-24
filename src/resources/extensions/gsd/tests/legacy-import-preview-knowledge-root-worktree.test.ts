// Project/App: gsd-pi
// File Purpose: Behavioral proof for retained-byte knowledge, root projection, and worktree contributions.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import type {
  LegacyImportPreviewDiagnosis,
  LegacyImportPreviewEnvelope,
  LegacyImportPreviewResolution,
  LegacyImportPreviewSource,
} from "../legacy-import-contract.ts";
import {
  decodeLegacyImportCapture,
  finalizeLegacyImportInterpretation,
  type LegacyImportInterpretation,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "../legacy-import-preview-interpretation.ts";
import { contributeLegacyKnowledgeProjection } from "../legacy-import-preview-knowledge.ts";
import { contributeLegacyRootProjections } from "../legacy-import-preview-root.ts";
import {
  captureLegacyImportSourceSet,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";
import { contributeLegacyWorktreeTopology } from "../legacy-import-preview-worktree.ts";
import { canonicalLegacyImportJson } from "../legacy-import-preview.ts";
import { loadLegacyImportCorpusCase } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);

function compareCanonical(left: unknown, right: unknown): number {
  const leftJson = canonicalLegacyImportJson(left);
  const rightJson = canonicalLegacyImportJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function temporaryDirectory(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "gsd-preview-projections-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function captureFixtureRoot(
  t: { after(fn: () => void): void },
  caseName: string,
  sourceName: string,
  logicalPath: string,
): { capture: LegacyImportSourceCapture; copiedRoot: string } {
  const base = temporaryDirectory(t);
  const copiedRoot = join(base, sourceName);
  cpSync(
    fileURLToPath(new URL(`./${caseName}/source/${sourceName}`, CORPUS_ROOT)),
    copiedRoot,
    { recursive: true, dereference: false, verbatimSymlinks: true },
  );
  return {
    capture: captureLegacyImportSourceSet({
      roots: [{
        id: "source",
        kind: "project",
        physical_path: copiedRoot,
        logical_path: logicalPath,
        presence: "required",
      }],
    }),
    copiedRoot,
  };
}

function captureWorktreeFixture(
  t: { after(fn: () => void): void },
): { capture: LegacyImportSourceCapture; copiedRoot: string } {
  const base = temporaryDirectory(t);
  const copiedRoot = join(base, "source");
  cpSync(
    fileURLToPath(new URL("./worktree-topology/source", CORPUS_ROOT)),
    copiedRoot,
    { recursive: true, dereference: false, verbatimSymlinks: true },
  );
  const roots: LegacyImportSourceRoot[] = readdirSync(copiedRoot).map((name) => ({
    id: name,
    kind: "project",
    physical_path: join(copiedRoot, name),
    logical_path: name,
    presence: "required",
  }));
  return { capture: captureLegacyImportSourceSet({ roots }), copiedRoot };
}

function captureFiles(
  t: { after(fn: () => void): void },
  logicalRoot: string,
  contents: Readonly<Record<string, string>>,
): { capture: LegacyImportSourceCapture; copiedRoot: string } {
  const copiedRoot = join(temporaryDirectory(t), "source");
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(copiedRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return {
    capture: captureLegacyImportSourceSet({
      roots: [{
        id: "arbitrary-root",
        kind: "project",
        physical_path: copiedRoot,
        logical_path: logicalRoot,
        presence: "required",
      }],
    }),
    copiedRoot,
  };
}

function sourcePaths(sources: readonly LegacyImportPreviewSource[]): Map<string, string> {
  return new Map(sources.map((source) => [source.source_id, source.path]));
}

function normalizedSources(sources: readonly LegacyImportPreviewSource[]): unknown[] {
  return sources.map(({ source_id: _sourceId, ...source }) => source);
}

function normalizedCandidates(
  candidates: LegacyImportInterpretation["candidates"] | LegacyImportPreviewEnvelope["changes"],
  paths: ReadonlyMap<string, string>,
): unknown[] {
  return candidates.map((candidate) => {
    let classification: "compare" | "preserve";
    if ("action" in candidate) {
      classification = candidate.action === "preserve" ? "preserve" : "compare";
    } else {
      classification = candidate.classification;
    }
    return {
      classification,
      target: candidate.target,
      raw: { ...candidate.raw, source_id: paths.get(candidate.raw.source_id) ?? candidate.raw.source_id },
      normalized: candidate.normalized,
      provenance: {
        ...candidate.provenance,
        source_id: paths.get(candidate.provenance.source_id) ?? candidate.provenance.source_id,
      },
      reason_code: candidate.reason_code,
    };
  }).sort(compareCanonical);
}

function diagnosisKey(
  diagnosis: LegacyImportPreviewDiagnosis,
  paths: ReadonlyMap<string, string>,
): string {
  return canonicalLegacyImportJson({
    code: diagnosis.code,
    source: paths.get(diagnosis.source_id) ?? diagnosis.source_id,
    locator: diagnosis.locator,
  });
}

function normalizedDiagnoses(
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  paths: ReadonlyMap<string, string>,
): unknown[] {
  return diagnoses.map(({ diagnosis_id: _diagnosisId, source_id: sourceId, ...diagnosis }) => ({
    ...diagnosis,
    source_id: paths.get(sourceId) ?? sourceId,
  })).sort(compareCanonical);
}

function normalizedResolutions(
  resolutions: readonly LegacyImportPreviewResolution[],
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  paths: ReadonlyMap<string, string>,
): unknown[] {
  const diagnosesById = new Map(diagnoses.map((diagnosis) => [
    diagnosis.diagnosis_id,
    diagnosisKey(diagnosis, paths),
  ]));
  return resolutions.map((resolution) => ({
    diagnosis: diagnosesById.get(resolution.diagnosis_id) ?? resolution.diagnosis_id,
    disposition: resolution.disposition,
    ...(resolution.target === undefined ? {} : { target: resolution.target }),
  })).sort(compareCanonical);
}

function assertOracleSemantics(
  interpretation: LegacyImportInterpretation,
  oracle: LegacyImportPreviewEnvelope,
): void {
  const actualPaths = sourcePaths(interpretation.sources);
  const expectedPaths = sourcePaths(oracle.sources);
  assert.deepEqual(normalizedSources(interpretation.sources), normalizedSources(oracle.sources));
  assert.deepEqual(
    normalizedCandidates(interpretation.candidates, actualPaths),
    normalizedCandidates(oracle.changes, expectedPaths),
  );
  assert.deepEqual(
    normalizedDiagnoses(interpretation.diagnoses, actualPaths),
    normalizedDiagnoses(oracle.diagnoses, expectedPaths),
  );
  assert.deepEqual(
    normalizedResolutions(interpretation.resolutions, interpretation.diagnoses, actualPaths),
    normalizedResolutions(oracle.resolutions, oracle.diagnoses, expectedPaths),
  );
}

function contributionArrays(): {
  candidates: LegacyImportPendingCandidate[];
  diagnoses: LegacyImportPendingDiagnosis[];
} {
  return { candidates: [], diagnoses: [] };
}

describe("legacy knowledge, root projection, and worktree contributions", () => {
  test("matches the sealed knowledge graph case after the captured source is deleted", (t) => {
    const { capture, copiedRoot } = captureFixtureRoot(t, "knowledge-graph", ".gsd", ".gsd");
    rmSync(copiedRoot, { recursive: true, force: true });
    const files = decodeLegacyImportCapture(capture, {
      sourceLabel: "knowledge",
      includes: (entry) => entry.kind !== "directory",
      parserId: () => "unclaimed",
      kind: (path) => path.endsWith(".json") ? "json" : "markdown",
      parserVersion: "1",
    });
    const { candidates, diagnoses } = contributionArrays();
    contributeLegacyKnowledgeProjection(files, candidates, diagnoses);
    assertOracleSemantics(
      finalizeLegacyImportInterpretation(files, candidates, diagnoses),
      loadLegacyImportCorpusCase(CORPUS_ROOT, "knowledge-graph").oracle,
    );
  });

  test("recognizes nested learnings from structure instead of milestone descriptors", (t) => {
    const { capture } = captureFiles(t, ".gsd", {
      "milestones/M123-arbitrary/M123-LEARNINGS.md": "# Learnings\n",
    });
    const files = decodeLegacyImportCapture(capture, {
      sourceLabel: "knowledge",
      includes: (entry) => entry.kind !== "directory",
      parserId: () => "unclaimed",
      kind: () => "markdown",
      parserVersion: "1",
    });
    const { candidates, diagnoses } = contributionArrays();
    contributeLegacyKnowledgeProjection(files, candidates, diagnoses);
    assert.deepEqual(candidates.map((candidate) => ({
      target: candidate.target,
      normalized: candidate.normalized,
      reason: candidate.reason_code,
    })), [{
      target: { kind: "legacy-knowledge-source", key: "M123-LEARNINGS" },
      normalized: { layout: "nested", milestone_id: "M123", preservation: "verbatim" },
      reason: "nested-learnings-preserved",
    }]);
  });

  test("preserves only root projections without deriving lifecycle truth", (t) => {
    const { capture, copiedRoot } = captureFixtureRoot(
      t, "root-external-boundaries", ".gsd", ".gsd",
    );
    rmSync(copiedRoot, { recursive: true, force: true });
    const files = decodeLegacyImportCapture(capture, {
      sourceLabel: "root projection",
      includes: (entry) => entry.kind !== "directory",
      parserId: () => "unclaimed",
      kind: () => "markdown",
      parserVersion: "1",
    });
    const { candidates, diagnoses } = contributionArrays();
    contributeLegacyRootProjections(files, candidates);
    const oracle = loadLegacyImportCorpusCase(CORPUS_ROOT, "root-external-boundaries").oracle;
    const rootOracle = {
      ...oracle,
      sources: oracle.sources.filter((source) => source.path.startsWith(".gsd/")),
      changes: oracle.changes.filter((change) => change.raw.source_id !== "boundary-external-database"),
    };
    const interpretation = finalizeLegacyImportInterpretation(files, candidates, diagnoses);
    assertOracleSemantics(interpretation, rootOracle);
    assert.ok(interpretation.candidates.every((candidate) => candidate.classification === "preserve"));
    assert.ok(interpretation.candidates.every((candidate) => candidate.target.kind === "artifact"));
  });

  test("does not label an unverified secrets manifest as sanitized", (t) => {
    const { capture } = captureFiles(t, ".gsd", {
      "SECRETS-MANIFEST.md": "# Secrets Manifest\n\nAPI token: synthetic-sensitive-value\n",
    });
    const files = decodeLegacyImportCapture(capture, {
      sourceLabel: "root projection",
      includes: (entry) => entry.kind !== "directory",
      parserId: () => "unclaimed",
      kind: () => "markdown",
      parserVersion: "1",
    });
    const { candidates } = contributionArrays();
    contributeLegacyRootProjections(files, candidates);
    assert.deepEqual(candidates[0]?.normalized, {
      path: ".gsd/SECRETS-MANIFEST.md",
      preservation: "verbatim",
      role: "secrets-manifest",
    });
    assert.equal(candidates[0]?.reason_code, "secrets-manifest-preserved");
    assert.ok(!canonicalLegacyImportJson(candidates[0]?.normalized).includes("synthetic-sensitive-value"));
  });

  test("matches all sealed worktree scenarios from retained bytes and capture metadata", (t) => {
    const { capture, copiedRoot } = captureWorktreeFixture(t);
    rmSync(copiedRoot, { recursive: true, force: true });
    const files = decodeLegacyImportCapture(capture, {
      sourceLabel: "worktree topology",
      includes: (entry) => entry.kind !== "directory",
      parserId: () => "unclaimed",
      kind: () => "unclaimed",
      parserVersion: "1",
    });
    const { candidates, diagnoses } = contributionArrays();
    contributeLegacyWorktreeTopology(files, candidates, diagnoses, capture);
    assertOracleSemantics(
      finalizeLegacyImportInterpretation(files, candidates, diagnoses),
      loadLegacyImportCorpusCase(CORPUS_ROOT, "worktree-topology").oracle,
    );
  });

  test("classifies an arbitrary-root worktree and leaves unrelated files unclaimed", (t) => {
    const { capture, copiedRoot } = captureFiles(t, "project", {
      ".gsd-worktrees/M123/git-marker.txt": "gitdir: ../../../.git/worktrees/M123\n",
      "notes.txt": "not topology evidence\n",
    });
    rmSync(copiedRoot, { recursive: true, force: true });
    const files = decodeLegacyImportCapture(capture, {
      sourceLabel: "worktree topology",
      includes: (entry) => entry.kind !== "directory",
      parserId: () => "unclaimed",
      kind: () => "unclaimed",
      parserVersion: "1",
    });
    const { candidates, diagnoses } = contributionArrays();
    contributeLegacyWorktreeTopology(files, candidates, diagnoses, capture);
    assert.deepEqual(candidates.map((candidate) => candidate.target), [{
      kind: "legacy-worktree-topology",
      key: "canonical/M123",
    }]);
    const notes = files.find((file) => file.entry.logical_path === "project/notes.txt");
    assert.equal(notes?.parserId, "unclaimed");
    assert.equal(notes?.outcome, "mapped");
  });

  test("contributes every milestone marker in a multi-worktree group", (t) => {
    const { capture, copiedRoot } = captureFiles(t, "project", {
      ".gsd-worktrees/M001/git-marker.txt": "gitdir: ../../../.git/worktrees/M001\n",
      ".gsd-worktrees/M002/git-marker.txt": "gitdir: ../../../.git/worktrees/M002\n",
      ".gsd/worktrees/M003/git-marker.txt": "gitdir: ../../../.git/worktrees/M003\n",
    });
    rmSync(copiedRoot, { recursive: true, force: true });
    const files = decodeLegacyImportCapture(capture, {
      sourceLabel: "worktree topology",
      includes: (entry) => entry.kind !== "directory",
      parserId: () => "unclaimed",
      kind: () => "unclaimed",
      parserVersion: "1",
    });
    const { candidates, diagnoses } = contributionArrays();
    contributeLegacyWorktreeTopology(files, candidates, diagnoses, capture);
    assert.deepEqual(
      candidates.map((candidate) => candidate.target.key).sort(),
      ["canonical/M001", "canonical/M002", "legacy/M003"],
    );
    assert.ok(
      files.every((file) => file.outcome === "preserved"),
      "no milestone marker may default to mapped without a candidate",
    );
    assert.deepEqual(diagnoses, []);
  });
});
