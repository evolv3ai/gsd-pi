// Project/App: gsd-pi
// File Purpose: Exact semantic corpus tests for pure legacy .planning interpretation.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import type {
  LegacyImportPreviewChange,
  LegacyImportPreviewDiagnosis,
  LegacyImportPreviewEnvelope,
  LegacyImportPreviewResolution,
  LegacyImportPreviewSource,
} from "../legacy-import-contract.ts";
import {
  interpretLegacyPlanningCapture,
  type LegacyImportPlanningCandidate,
  type LegacyImportPlanningInterpretation,
} from "../legacy-import-preview-planning.ts";
import {
  captureLegacyImportSourceSet,
  type LegacyImportSourceCapture,
} from "../legacy-import-preview-source.ts";
import { canonicalLegacyImportJson, hashLegacyImportBytes, hashLegacyImportValue } from "../legacy-import-preview.ts";
import { loadLegacyImportCorpusCase } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const PLANNING_CASES = [
  "planning-flat-complete",
  "planning-loss-surfaces",
  "planning-milestone-dirs",
  "planning-multi-milestone",
  "planning-multi-milestone-completed-range",
  "planning-multi-milestone-details",
  "planning-multi-milestone-emoji-range",
  "planning-multi-milestone-heading",
  "planning-multi-milestone-summary",
  "planning-number-aliases",
] as const;

function compareCanonical(left: unknown, right: unknown): number {
  const leftJson = canonicalLegacyImportJson(left);
  const rightJson = canonicalLegacyImportJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function candidateOrderValue(candidate: LegacyImportPlanningCandidate) {
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

function withoutOrdinal<T extends { ordinal?: number }>(candidate: T): Omit<T, "ordinal"> {
  const { ordinal: _ordinal, ...value } = candidate;
  return value;
}

function temporaryDirectory(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "gsd-planning-preview-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function captureCase(
  t: { after(fn: () => void): void },
  caseName: (typeof PLANNING_CASES)[number],
): { capture: LegacyImportSourceCapture; physicalRoot: string; oracle: LegacyImportPreviewEnvelope } {
  const base = temporaryDirectory(t);
  const physicalRoot = join(base, ".planning");
  const source = fileURLToPath(new URL(`./${caseName}/source/.planning`, CORPUS_ROOT));
  cpSync(source, physicalRoot, { recursive: true, dereference: false });
  const capture = captureLegacyImportSourceSet({
    roots: [{
      id: "planning",
      kind: "project",
      physical_path: physicalRoot,
      logical_path: ".planning",
      presence: "required",
    }],
  });
  return { capture, physicalRoot, oracle: loadLegacyImportCorpusCase(CORPUS_ROOT, caseName).oracle };
}

function captureFiles(
  t: { after(fn: () => void): void },
  files: Readonly<Record<string, string>>,
): LegacyImportSourceCapture {
  const base = temporaryDirectory(t);
  const planning = join(base, ".planning");
  for (const [path, content] of Object.entries(files)) {
    const physical = join(planning, path);
    mkdirSync(dirname(physical), { recursive: true });
    writeFileSync(physical, content);
  }
  return captureLegacyImportSourceSet({
    roots: [{ id: "planning", kind: "project", physical_path: planning, logical_path: ".planning", presence: "required" }],
  });
}

function sourcePathsById(sources: readonly LegacyImportPreviewSource[]): Map<string, string> {
  return new Map(sources.map((source) => [source.source_id, source.path]));
}

function normalizedSources(sources: readonly LegacyImportPreviewSource[]) {
  return sources.map(({ source_id: _sourceId, ...source }) => source);
}

function normalizedCandidates(
  candidates: readonly (LegacyImportPlanningCandidate | LegacyImportPreviewChange)[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  return candidates.map((candidate) => {
    const runtime = candidate as Partial<LegacyImportPlanningCandidate>;
    return {
      target: candidate.target,
      raw: {
        ...candidate.raw,
        source_id: sourcePaths.get(candidate.raw.source_id) ?? candidate.raw.source_id,
      },
      normalized: candidate.normalized,
      provenance: {
        ...candidate.provenance,
        source_id: sourcePaths.get(candidate.provenance.source_id) ?? candidate.provenance.source_id,
      },
      reason_code: candidate.reason_code,
      ...(runtime.ordinal === undefined ? {} : { ordinal: runtime.ordinal }),
    };
  }).sort((left, right) => compareCanonical(withoutOrdinal(left), withoutOrdinal(right)));
}

function diagnosisKey(
  diagnosis: LegacyImportPreviewDiagnosis,
  sourcePaths: ReadonlyMap<string, string>,
): string {
  return canonicalLegacyImportJson({
    code: diagnosis.code,
    source: sourcePaths.get(diagnosis.source_id) ?? diagnosis.source_id,
    locator: diagnosis.locator,
  });
}

function normalizedDiagnoses(
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  return diagnoses.map(({ diagnosis_id: _diagnosisId, source_id: sourceId, ...diagnosis }) => ({
    ...diagnosis,
    source_id: sourcePaths.get(sourceId) ?? sourceId,
  })).sort(compareCanonical);
}

function normalizedResolutions(
  resolutions: readonly LegacyImportPreviewResolution[],
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  const keys = new Map(diagnoses.map((diagnosis) => [
    diagnosis.diagnosis_id,
    diagnosisKey(diagnosis, sourcePaths),
  ]));
  return resolutions.map((resolution) => ({
    diagnosis: keys.get(resolution.diagnosis_id) ?? resolution.diagnosis_id,
    disposition: resolution.disposition,
    ...(resolution.target === undefined ? {} : { target: resolution.target }),
  })).sort(compareCanonical);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function assertRuntimeIdentity(
  capture: LegacyImportSourceCapture,
  interpretation: LegacyImportPlanningInterpretation,
): void {
  const capturedSourceIds = new Map(capture.entries.flatMap((entry) => (
    entry.kind === "file" || entry.kind === "symlink"
      ? [[entry.logical_path, entry.source_id] as const]
      : []
  )));
  const emittedSourceIds = new Set(interpretation.sources.map((source) => source.source_id));
  for (const source of interpretation.sources) {
    assert.equal(source.source_id, capturedSourceIds.get(source.path), `${source.path}: captured source ID`);
  }
  for (const candidate of interpretation.candidates) {
    assert.match(candidate.candidate_id, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(emittedSourceIds.has(candidate.raw.source_id), `${candidate.candidate_id}: raw source ID`);
    assert.ok(emittedSourceIds.has(candidate.provenance.source_id), `${candidate.candidate_id}: provenance source ID`);
    assert.equal(candidate.raw.source_id, candidate.provenance.source_id);
    const { candidate_id: _candidateId, ordinal: _ordinal, ...candidateIdentity } = candidate;
    assert.equal(candidate.candidate_id, hashLegacyImportValue(candidateIdentity));
    assert.equal(
      candidate.classification,
      candidate.target.kind.startsWith("legacy-") ? "preserve" : "compare",
      `${candidate.candidate_id}: classification`,
    );
  }
  assert.equal(
    new Set(interpretation.candidates.map((candidate) => candidate.candidate_id)).size,
    interpretation.candidates.length,
    "candidate IDs are unique",
  );
  for (const diagnosis of interpretation.diagnoses) {
    assert.ok(emittedSourceIds.has(diagnosis.source_id), `${diagnosis.diagnosis_id}: diagnosis source ID`);
    const { diagnosis_id: _diagnosisId, ...diagnosisIdentity } = diagnosis;
    assert.equal(diagnosis.diagnosis_id, hashLegacyImportValue(diagnosisIdentity));
  }
}

function semanticInterpretation(
  interpretation: LegacyImportPlanningInterpretation,
  oracle: LegacyImportPreviewEnvelope,
) {
  const runtimePaths = sourcePathsById(interpretation.sources);
  const oraclePaths = sourcePathsById(oracle.sources);
  return {
    actual: {
      sources: normalizedSources(interpretation.sources),
      candidates: normalizedCandidates(interpretation.candidates, runtimePaths)
        .map(({ ordinal: _ordinal, ...candidate }) => candidate),
      diagnoses: normalizedDiagnoses(interpretation.diagnoses, runtimePaths),
      resolutions: normalizedResolutions(interpretation.resolutions, interpretation.diagnoses, runtimePaths),
    },
    expected: {
      sources: normalizedSources(oracle.sources),
      candidates: normalizedCandidates(oracle.changes, oraclePaths),
      diagnoses: normalizedDiagnoses(oracle.diagnoses, oraclePaths),
      resolutions: normalizedResolutions(oracle.resolutions, oracle.diagnoses, oraclePaths),
    },
  };
}

function assertLocatorEvidence(
  capture: LegacyImportSourceCapture,
  interpretation: LegacyImportPlanningInterpretation,
): void {
  const pathsById = sourcePathsById(interpretation.sources);
  const bytesByPath = new Map(capture.entries.flatMap((entry) => {
    if (entry.kind !== "file" || entry.payload_id === undefined) return [];
    const payload = capture.payloads.find((candidate) => candidate.payload_id === entry.payload_id);
    return payload ? [[entry.logical_path, Buffer.from(payload.bytes_base64, "base64")] as const] : [];
  }));
  const evidence = [
    ...interpretation.candidates.map((candidate) => ({
      sourceId: candidate.raw.source_id,
      locator: candidate.raw.locator,
      rawValue: candidate.raw.value,
      sha256: candidate.raw.sha256,
    })),
    ...interpretation.diagnoses.map((diagnosis) => ({
      sourceId: diagnosis.source_id,
      locator: diagnosis.locator,
      rawValue: diagnosis.raw_value,
      sha256: undefined,
    })),
  ];
  for (const item of evidence) {
    const path = pathsById.get(item.sourceId);
    assert.ok(path, `unknown evidence source ${item.sourceId}`);
    const bytes = bytesByPath.get(path);
    assert.ok(bytes, `missing captured bytes for ${path}`);
    assert.notEqual(item.locator.end_byte, undefined, `${path}: end_byte`);
    const raw = bytes.subarray(item.locator.start_byte, item.locator.end_byte);
    assert.equal(raw.toString("utf8"), item.rawValue, `${path}: raw byte span`);
    if (item.sha256 !== undefined) assert.equal(item.sha256, hashLegacyImportBytes(raw), `${path}: raw hash`);
    const line = bytes.subarray(0, item.locator.start_byte).reduce(
      (value, byte) => value + (byte === 10 ? 1 : 0),
      1,
    );
    assert.equal(item.locator.line, line, `${path}: line`);
  }
}

describe("legacy preview planning", () => {
  test("legacy preview planning uses retained captured bytes only", (t) => {
    const fixture = captureCase(t, "planning-flat-complete");
    rmSync(fixture.physicalRoot, { recursive: true, force: true });

    const first = interpretLegacyPlanningCapture(fixture.capture);
    const second = interpretLegacyPlanningCapture(fixture.capture);
    const semantic = semanticInterpretation(first, fixture.oracle);

    assert.deepEqual(semantic.actual, semantic.expected);
    assert.deepEqual(first, second);
    assertDeepFrozen(first);

    const equivalent = captureCase(t, "planning-flat-complete");
    assert.deepEqual(
      interpretLegacyPlanningCapture(equivalent.capture),
      first,
      "equivalent bytes captured from a different physical root retain Preview identity",
    );
  });

  test("legacy preview planning matches all sealed planning semantics", (t) => {
    for (const caseName of PLANNING_CASES) {
      const fixture = captureCase(t, caseName);
      const interpretation = interpretLegacyPlanningCapture(fixture.capture);
      const semantic = semanticInterpretation(interpretation, fixture.oracle);

      assert.deepEqual(semantic.actual, semantic.expected, caseName);
      assertRuntimeIdentity(fixture.capture, interpretation);
      const canonicalCandidateOrder = [...interpretation.candidates]
        .sort((left, right) => compareCanonical(candidateOrderValue(left), candidateOrderValue(right)));
      assert.deepEqual(interpretation.candidates, canonicalCandidateOrder, `${caseName}: canonical candidate order`);
      assert.deepEqual(
        interpretation.candidates.map((candidate) => candidate.ordinal),
        interpretation.candidates.map((_, index) => index + 1),
        `${caseName}: ordinals`,
      );
      assertLocatorEvidence(fixture.capture, interpretation);
      assert.equal(new Set(interpretation.diagnoses.map((diagnosis) => diagnosis.diagnosis_id)).size, interpretation.diagnoses.length);
      assert.deepEqual(
        [...interpretation.resolutions.map((resolution) => resolution.diagnosis_id)].sort(),
        [...interpretation.diagnoses.map((diagnosis) => diagnosis.diagnosis_id)].sort(),
        `${caseName}: every diagnosis resolves exactly once`,
      );
    }
  });

  test("legacy preview planning treats invalid UTF-8 as unsupported evidence", (t) => {
    const base = temporaryDirectory(t);
    const planning = join(base, ".planning");
    mkdirSync(planning);
    writeFileSync(join(planning, "ROADMAP.md"), Buffer.from([0xff, 0x00, 0x61]));
    const capture = captureLegacyImportSourceSet({
      roots: [{
        id: "planning",
        kind: "project",
        physical_path: planning,
        logical_path: ".planning",
        presence: "required",
      }],
    });

    const interpretation = interpretLegacyPlanningCapture(capture);
    const sourceEntry = capture.entries.find((entry) => entry.logical_path === ".planning/ROADMAP.md");
    assert.ok(sourceEntry);
    assert.equal(interpretation.sources.length, 1);
    assert.deepEqual(interpretation.sources[0], {
      source_id: sourceEntry.source_id,
      path: ".planning/ROADMAP.md",
      kind: "markdown",
      byte_size: 3,
      sha256: sourceEntry.sha256,
      parser_id: "planning-roadmap-parser",
      parser_version: "1",
      encoding: "binary",
      outcome: "unparsed",
    });
    assert.deepEqual(interpretation.candidates, []);
    assert.equal(interpretation.diagnoses.length, 1);
    assert.deepEqual(interpretation.diagnoses[0], {
      diagnosis_id: interpretation.resolutions[0]?.diagnosis_id,
      code: "unsupported-planning-encoding",
      severity: "blocker",
      source_id: sourceEntry.source_id,
      locator: { start_byte: 0, end_byte: 3, line: 1 },
      raw_value: "sha256:f9789675a25a87605b0d60387568e25cda7b568653ecdc42e9248588dc70acd5",
      message: "Planning input is not valid UTF-8 and cannot be interpreted safely.",
    });
    assert.deepEqual(interpretation.resolutions, [{
      diagnosis_id: interpretation.diagnoses[0].diagnosis_id,
      disposition: "unsupported",
    }]);
    assertRuntimeIdentity(capture, interpretation);
    assertDeepFrozen(interpretation);
  });

  test("legacy preview planning fails closed for malformed roadmap grammars", (t) => {
    const roadmaps = [
      "# Project Roadmap\n\n<details>\n<summary>v1.0 Missing shape</summary>\n</details>\n",
      "# Project Roadmap\n\n## Milestones\n\n- [x] **Phase 1: Broken** — Phases 3-1 (shipped)\n",
      "# Project Roadmap\n\n## Milestones\n\n- [x] **Phase 1: Huge** — Phases 1-5000 (shipped)\n",
      "# Project Roadmap\n\n## Phases\n\n- ✅ **v1.0 Missing range**\n",
      "# Project Roadmap\n\n## v1.0 — Empty milestone\n",
      "# Project Roadmap\n\n## Milestones\n\n### v1.0 Missing summary\n\n- [x] **Phase 1: Work** — done\n",
    ];
    for (const roadmap of roadmaps) {
      const interpretation = interpretLegacyPlanningCapture(captureFiles(t, { "ROADMAP.md": roadmap }));
      assert.equal(interpretation.sources[0].outcome, "unparsed");
      assert.equal(interpretation.candidates.filter((candidate) => candidate.classification === "compare").length, 0);
      assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), ["malformed-roadmap-grammar"]);
      assert.deepEqual(interpretation.resolutions.map((resolution) => resolution.disposition), ["requires-user"]);
    }
  });

  test("legacy preview planning pairs a summary with its exact flat task", (t) => {
    const capture = captureFiles(t, {
      "ROADMAP.md": "# Roadmap\n\n- [ ] 01 — First\n- [ ] 02 — Second\n",
      "phases/01-first/01-01-PLAN.md": "---\nphase: \"01-first\"\nplan: \"01\"\n---\n\n# 01-01: First task\n\n<objective>First objective.</objective>\n",
      "phases/02-second/02-01-PLAN.md": "---\nphase: \"02-second\"\nplan: \"01\"\n---\n\n# 02-01: Second task\n\n<objective>Second objective.</objective>\n",
      "phases/02-second/02-01-SUMMARY.md": "---\nphase: \"02-second\"\nplan: \"01\"\n---\n\n# Summary\n\nSecond complete.\n",
    });
    const interpretation = interpretLegacyPlanningCapture(capture);
    assert.deepEqual(
      interpretation.candidates.filter((candidate) => candidate.target.kind === "task").map((candidate) => candidate.target),
      [
        { kind: "task", key: "M001/S01/T01" },
        { kind: "task", key: "M001/S02/T01" },
        { kind: "task", key: "M001/S02/T01", field: "status" },
      ],
    );
  });

  test("legacy preview planning never parses symlink bytes as Markdown", (t) => {
    const base = temporaryDirectory(t);
    const planning = join(base, ".planning");
    mkdirSync(planning);
    writeFileSync(join(base, "outside.md"), "# Project Roadmap\n\n- [x] 01 — Must not map\n");
    symlinkSync("../outside.md", join(planning, "ROADMAP.md"));
    const capture = captureLegacyImportSourceSet({
      roots: [
        { id: "planning", kind: "project", physical_path: planning, logical_path: ".planning", presence: "required" },
        { id: "outside", kind: "external", physical_path: join(base, "outside.md"), logical_path: "outside.md", presence: "required" },
      ],
    });
    const interpretation = interpretLegacyPlanningCapture(capture);
    assert.deepEqual(interpretation.candidates, []);
    assert.equal(interpretation.sources[0].encoding, "binary");
    assert.equal(interpretation.sources[0].outcome, "unparsed");
    assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), ["unsupported-planning-encoding"]);
  });

  test("legacy preview planning rejects corrupted retained payload evidence", (t) => {
    const capture = structuredClone(captureFiles(t, { "ROADMAP.md": "# Roadmap\n" }));
    capture.payloads[0].bytes_base64 = Buffer.from("# Roadmax\n").toString("base64");
    const { capture_hash: _captureHash, ...captureValue } = capture;
    capture.capture_hash = hashLegacyImportValue(captureValue);
    assert.throws(() => interpretLegacyPlanningCapture(capture), /captured planning payload/u);

    const kindCapture = structuredClone(captureFiles(t, { "ROADMAP.md": "# Roadmap\n" }));
    kindCapture.payloads[0].kind = "symlink";
    const { capture_hash: _kindHash, ...kindValue } = kindCapture;
    kindCapture.capture_hash = hashLegacyImportValue(kindValue);
    assert.throws(() => interpretLegacyPlanningCapture(kindCapture), /captured planning payload/u);

    const identityCapture = structuredClone(captureFiles(t, { "ROADMAP.md": "# Roadmap\n" }));
    identityCapture.entries[0].source_id = `sha256:${"0".repeat(64)}`;
    const { capture_hash: _identityHash, ...identityValue } = identityCapture;
    identityCapture.capture_hash = hashLegacyImportValue(identityValue);
    assert.throws(() => interpretLegacyPlanningCapture(identityCapture), /source .* identity is inconsistent/u);

    const payloadIdentityCapture = structuredClone(captureFiles(t, { "ROADMAP.md": "# Roadmap\n" }));
    const forgedPayloadId = `sha256:${"1".repeat(64)}` as const;
    const fileEntry = payloadIdentityCapture.entries.find((entry) => entry.kind === "file")!;
    fileEntry.payload_id = forgedPayloadId;
    payloadIdentityCapture.payloads[0].payload_id = forgedPayloadId;
    const { capture_hash: _payloadIdentityHash, ...payloadIdentityValue } = payloadIdentityCapture;
    payloadIdentityCapture.capture_hash = hashLegacyImportValue(payloadIdentityValue);
    assert.throws(() => interpretLegacyPlanningCapture(payloadIdentityCapture), /captured planning payload/u);

    const rootCapture = structuredClone(captureFiles(t, { "ROADMAP.md": "# Roadmap\n" }));
    rootCapture.roots[0].logical_path = "totally-unrelated";
    const { capture_hash: _rootHash, ...rootValue } = rootCapture;
    rootCapture.capture_hash = hashLegacyImportValue(rootValue);
    assert.throws(() => interpretLegacyPlanningCapture(rootCapture), /source .* identity is inconsistent/u);
  });

  test("legacy preview planning scopes multiple milestone directories and plans", (t) => {
    const plan = (phase: string, number: string, title: string) => `---\nphase: \"${phase}\"\nplan: \"${number}\"\n---\n\n# ${number}: ${title}\n\n<objective>${title} objective.</objective>\n`;
    const capture = captureFiles(t, {
      "milestones/v1.0-ROADMAP.md": "# v1.0 Roadmap\n\n- [ ] 01 — First\n",
      "milestones/v1.0-phases/01-first/01-PLAN.md": plan("01-first", "01", "First A"),
      "milestones/v1.0-phases/01-first/02-PLAN.md": plan("01-first", "02", "First B"),
      "milestones/v2.0-ROADMAP.md": "# v2.0 Roadmap\n\n- [ ] 01 — Second\n",
      "milestones/v2.0-phases/01-second/01-PLAN.md": plan("01-second", "01", "Second A"),
    });
    const interpretation = interpretLegacyPlanningCapture(capture);
    assert.deepEqual(
      interpretation.candidates.filter((candidate) => candidate.target.kind === "milestone").map((candidate) => candidate.target.key),
      ["M001", "M002"],
    );
    assert.deepEqual(
      interpretation.candidates.filter((candidate) => candidate.target.kind === "task").map((candidate) => candidate.target.key),
      ["M001/S01/T01", "M001/S01/T02", "M002/S01/T01"],
    );
  });

  test("legacy preview planning rejects competing flat and milestone layouts", (t) => {
    const interpretation = interpretLegacyPlanningCapture(captureFiles(t, {
      "ROADMAP.md": "# Roadmap\n\n- [ ] 01 — Flat\n",
      "milestones/v1.0-ROADMAP.md": "# v1.0 Roadmap\n\n- [ ] 01 — Nested\n",
    }));
    assert.equal(interpretation.candidates.some((candidate) => candidate.classification === "compare"), false);
    assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), ["competing-planning-layouts"]);
    assert.deepEqual(interpretation.sources.map((source) => source.outcome), ["unparsed", "unparsed"]);
  });

  test("legacy preview planning rejects duplicate milestone roadmap membership", (t) => {
    const interpretation = interpretLegacyPlanningCapture(captureFiles(t, {
      "milestones/v1.0-ROADMAP.md": "# v1.0 Roadmap\n\n- [ ] 01 — First\n- [ ] 01 — Duplicate\n",
      "milestones/v1.0-phases/01-first/01-PLAN.md": "---\nphase: \"01-first\"\nplan: \"01\"\n---\n\n<objective>Do not guess.</objective>\n",
    }));
    assert.equal(interpretation.candidates.some((candidate) => candidate.classification === "compare"), false);
    assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), ["duplicate-phase-number"]);
    assert.deepEqual(interpretation.sources.map((source) => source.outcome), ["unparsed", "unparsed"]);
  });

  test("legacy preview planning reads keys only from opening frontmatter", (t) => {
    const interpretation = interpretLegacyPlanningCapture(captureFiles(t, {
      "ROADMAP.md": "# Roadmap\n\n- [ ] 01 — Safe\n",
      "phases/01-safe/01-01-PLAN.md": "---\nphase: \"01-safe\"\nplan: \"01\"\n---\n\n# 01-01: Safe\n\n<objective>Keep body keys inert.</objective>\n\nstatus: skipped\nplan: \"99\"\n",
    }));
    assert.deepEqual(
      interpretation.candidates.filter((candidate) => candidate.target.kind === "task").map((candidate) => candidate.normalized),
      [{ id: "T01", slice_id: "S01", sequence: 1, status: "planned", title: "Safe", objective: "Keep body keys inert." }],
    );
  });

  test("legacy preview planning quarantines plans behind an ambiguous roadmap", (t) => {
    const interpretation = interpretLegacyPlanningCapture(captureFiles(t, {
      "ROADMAP.md": "# Roadmap\n\n## v1.0 — One\n\n- [ ] 01 — Work\n\n<details>\n<summary>v2.0 Two (Phase 2) -- ACTIVE</summary>\n\n- [ ] 02 — More\n\n</details>\n",
      "phases/01-work/01-01-PLAN.md": "---\nphase: \"01-work\"\nplan: \"01\"\n---\n\n# 01-01: Must wait\n\n<objective>Do not infer membership.</objective>\n",
    }));
    assert.equal(interpretation.candidates.some((candidate) => candidate.classification === "compare"), false);
    assert.deepEqual(
      interpretation.diagnoses.map((diagnosis) => diagnosis.code),
      ["competing-roadmap-grammars", "unresolved-plan-membership"],
    );
    assert.deepEqual(interpretation.sources.map((source) => source.outcome), ["unparsed", "unparsed"]);
  });

  test("legacy preview planning rejects conflicting plan and summary identity", (t) => {
    const interpretation = interpretLegacyPlanningCapture(captureFiles(t, {
      "ROADMAP.md": "# Roadmap\n\n- [ ] 01 — Safe\n",
      "phases/01-safe/01-01-PLAN.md": "---\nphase: \"02-wrong\"\nplan: \"01\"\n---\n\n# 01-01: Wrong phase\n\n<objective>Do not map.</objective>\n",
      "phases/01-safe/01-01-SUMMARY.md": "---\nphase: \"01-safe\"\nplan: \"99\"\n---\n\n# Summary\n\nDo not complete.\n",
    }));
    assert.equal(interpretation.candidates.some((candidate) => candidate.target.kind === "task"), false);
    assert.deepEqual(
      interpretation.diagnoses.map((diagnosis) => diagnosis.code),
      ["plan-phase-conflict", "summary-identity-conflict"],
    );
  });

  test("legacy preview planning preserves incomplete milestone plans explicitly", (t) => {
    const interpretation = interpretLegacyPlanningCapture(captureFiles(t, {
      "milestones/v1.0-ROADMAP.md": "# v1.0 Roadmap\n\n- [ ] 01 — First\n",
      "milestones/v1.0-phases/01-first/01-PLAN.md": "---\nphase: \"01-first\"\nplan: \"01\"\n---\n\n# 01-01: Missing objective\n",
    }));
    assert.equal(interpretation.candidates.some((candidate) => candidate.target.kind === "task"), false);
    assert.equal(interpretation.candidates.some((candidate) => candidate.target.kind === "legacy-artifact"), true);
    assert.deepEqual(interpretation.diagnoses.map((diagnosis) => diagnosis.code), ["unresolved-plan-membership"]);
    assert.equal(interpretation.sources.find((source) => source.path.endsWith("PLAN.md"))?.outcome, "unparsed");
  });

  test("legacy preview planning exposes malformed milestone surfaces", (t) => {
    const interpretation = interpretLegacyPlanningCapture(captureFiles(t, {
      "milestones/v1.0-ROADMAP.md": "# v1.0 Roadmap\n\n- [ ] 01 — First\n- [~] broken membership\n",
      "milestones/v1.0-REQUIREMENTS.md": "# Requirements\n\n- this row is malformed\n",
      "milestones/v1.0-phases/01-first/01-PLAN.md": "---\nphase: \"01-first\"\nplan: \"01\"\n---\n\n# 99: Wrong identity\n\n<objective>Do not map.</objective>\n",
      "milestones/v1.0-phases/01-first/02-PLAN.md": "---\nphase: \"01-first\"\nplan: \"02\"\n---\n\n# 01-02: Placeholder\n\n<objective>TODO</objective>\n",
    }));
    assert.equal(interpretation.candidates.some((candidate) => candidate.target.kind === "task"), false);
    assert.deepEqual(
      new Set(interpretation.diagnoses.map((diagnosis) => diagnosis.code)),
      new Set(["malformed-roadmap-row", "malformed-requirements", "plan-identity-conflict", "placeholder-plan"]),
    );
    assert.equal(
      interpretation.sources.filter((source) => source.outcome === "unparsed").length,
      3,
    );
  });
});
