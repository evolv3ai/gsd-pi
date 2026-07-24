// Project/App: gsd-pi
// File Purpose: Exactly-once, captured-byte composition tests for legacy import Preview interpretation.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  composeLegacyImportInterpretation,
  LegacyImportCompositionError,
} from "../legacy-import-preview-composition.ts";
import type {
  LegacyImportGsdDatabaseEvidence,
  LegacyImportGsdDatabaseObservation,
} from "../legacy-import-preview-gsd.ts";
import {
  captureLegacyImportSourceSet,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportBytes,
  hashLegacyImportValue,
} from "../legacy-import-preview.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const COMPOSITE_FILES = [
  ".planning/ROADMAP.md",
  ".gsd/DECISIONS.md",
  ".gsd/KNOWLEDGE.md",
  ".gsd/workflows/capstone.yaml",
  ".gsd-worktrees/M008/git-marker.txt",
] as const;

function temporaryDirectory(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "gsd-preview-composition-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function root(
  source: string,
  id: string,
  logicalPath: string,
  kind: LegacyImportSourceRoot["kind"],
): LegacyImportSourceRoot {
  return {
    id,
    kind,
    physical_path: join(source, logicalPath),
    logical_path: logicalPath,
    presence: "required",
  };
}

function compositeCapture(t: { after(fn: () => void): void }): LegacyImportSourceCapture {
  const source = join(temporaryDirectory(t), "source");
  const fixture = fileURLToPath(new URL("./composite-capstone/source/", CORPUS_ROOT));
  for (const path of COMPOSITE_FILES) {
    const destination = join(source, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(fixture, path), destination, { dereference: false, verbatimSymlinks: true });
  }
  const capture = captureLegacyImportSourceSet({
    roots: [
      root(source, "planning", ".planning", "project"),
      root(source, "gsd", ".gsd", "project"),
      root(source, "worktrees", ".gsd-worktrees", "worktree"),
    ],
  });
  rmSync(source, { recursive: true, force: true });
  return capture;
}

function databaseEvidence(capture: LegacyImportSourceCapture): LegacyImportGsdDatabaseEvidence {
  const entry = capture.entries.find((candidate) => candidate.logical_path === ".gsd/gsd.db");
  assert.ok(entry?.sha256 !== undefined && entry.byte_size !== undefined);
  const observations: LegacyImportGsdDatabaseObservation[] = [
    {
      table: "slices" as const,
      key: { milestone_id: "M001", id: "S01" },
      field: "depends",
      value: ["S02"],
      raw: {
        locator: { start_byte: 0, end_byte: 7, line: 1 },
        value: '["S02"]',
        sha256: hashLegacyImportBytes('["S02"]'),
      },
    },
    {
      table: "slice_dependencies" as const,
      key: { milestone_id: "M001", slice_id: "S01" },
      field: "depends_on_slice_id" as const,
      value: "S03",
      raw: {
        locator: { start_byte: 8, end_byte: 11, line: 2 },
        value: "S03",
        sha256: hashLegacyImportBytes("S03"),
      },
    },
  ];
  const value = {
    evidence_version: 1 as const,
    inspection_version: 1 as const,
    capture_hash: capture.capture_hash,
    source_id: entry.source_id,
    source_sha256: entry.sha256,
    source_byte_size: entry.byte_size,
    coverage: [
      { table: "slices" as const, field: "depends" as const, complete: true as const, row_count: 1 },
      {
        table: "slice_dependencies" as const,
        field: "depends_on_slice_id" as const,
        complete: true as const,
        row_count: 1,
      },
    ],
    observations,
  };
  return { ...value, evidence_hash: hashLegacyImportValue(value) };
}

describe("legacy import Preview composition", () => {
  test("composes mixed retained bytes with exactly one owner and stable global ordinals", (t) => {
    const capture = compositeCapture(t);

    const first = composeLegacyImportInterpretation(capture);
    const second = composeLegacyImportInterpretation(capture);

    assert.deepEqual(second, first);
    assert.deepEqual(first.sources.map((source) => source.path).sort(), [...COMPOSITE_FILES].sort());
    assert.equal(new Set(first.sources.map((source) => source.source_id)).size, COMPOSITE_FILES.length);
    assert.deepEqual(
      first.candidates.map((candidate) => candidate.ordinal),
      first.candidates.map((_candidate, index) => index + 1),
    );
    assert.deepEqual(
      first.candidates.map((candidate) => candidate.candidate_id),
      [...first.candidates].map((candidate) => candidate.candidate_id).sort(),
    );
    const parsers = new Map(first.sources.map((source) => [source.path, source.parser_id]));
    assert.equal(parsers.get(".planning/ROADMAP.md"), "planning-roadmap-parser");
    assert.equal(parsers.get(".gsd/DECISIONS.md"), "gsd-decisions-table");
    assert.equal(parsers.get(".gsd/KNOWLEDGE.md"), "gsd-knowledge-graph");
    assert.equal(parsers.get(".gsd/workflows/capstone.yaml"), "gsd-workflow-definition");
    assert.equal(parsers.get(".gsd-worktrees/M008/git-marker.txt"), "gsd-worktree-topology");
  });

  test("fails loudly when a captured source has no interpreter owner", (t) => {
    const source = join(temporaryDirectory(t), "misc");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "unknown.txt"), "retained but not modeled\n");
    const capture = captureLegacyImportSourceSet({
      roots: [{
        id: "misc",
        kind: "external",
        physical_path: source,
        logical_path: "misc",
        presence: "required",
      }],
    });

    assert.throws(
      () => composeLegacyImportInterpretation(capture),
      (error) => error instanceof LegacyImportCompositionError
        && error.code === "LEGACY_IMPORT_COMPOSITION_SOURCE_UNCLAIMED"
        && error.context.logical_path === "misc/unknown.txt",
    );
  });

  test("uses supplemental ownership for an evidence-consumer database source", (t) => {
    const source = join(temporaryDirectory(t), "source");
    const database = join(source, ".gsd", "gsd.db");
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, '["S02"]\nS03');
    writeFileSync(`${database}-wal`, "retained wal");
    writeFileSync(`${database}-shm`, "retained shm");
    const capture = captureLegacyImportSourceSet({
      roots: [root(source, "gsd", ".gsd", "project")],
    });
    const evidence = databaseEvidence(capture);

    const interpretation = composeLegacyImportInterpretation(capture, {
      gsdDatabaseEvidence: [evidence],
    });

    const databaseSources = interpretation.sources.filter((candidate) => candidate.path === ".gsd/gsd.db");
    assert.equal(databaseSources.length, 1);
    assert.equal(databaseSources[0]?.parser_id, "gsd-sqlite-target");
    assert.equal(databaseSources[0]?.outcome, "mapped");
    const evidenceChanges = interpretation.candidates.filter((candidate) => (
      candidate.provenance.source_id === evidence.source_id
    ));
    assert.equal(evidenceChanges.length, 2);
    assert.deepEqual(
      evidenceChanges.map((candidate) => candidate.target.key).sort(),
      ["M001/S01/dependency-junction", "M001/S01/depends-column"],
    );
    assert.ok(evidenceChanges.every((candidate) => (
      candidate.provenance.parser_id === databaseSources[0]?.parser_id
    )));
  });

  test("rejects tampered database evidence before rebinding it to the GSD view", (t) => {
    const source = join(temporaryDirectory(t), "source");
    const database = join(source, ".gsd", "gsd.db");
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, '["S02"]\nS03');
    writeFileSync(`${database}-wal`, "retained wal");
    writeFileSync(`${database}-shm`, "retained shm");
    const capture = captureLegacyImportSourceSet({
      roots: [root(source, "gsd", ".gsd", "project")],
    });
    const evidence = databaseEvidence(capture);

    assert.throws(
      () => composeLegacyImportInterpretation(capture, {
        gsdDatabaseEvidence: [{ ...evidence, evidence_hash: hashLegacyImportValue("tampered") }],
      }),
      (error) => error instanceof LegacyImportCompositionError
        && error.code === "LEGACY_IMPORT_COMPOSITION_DATABASE_EVIDENCE_INVALID",
    );
  });
});

test("composition consumes retained bytes without rereading removed source paths", (t) => {
  const capture = compositeCapture(t);
  const result = composeLegacyImportInterpretation(capture);
  assert.equal(result.sources.length, COMPOSITE_FILES.length);
  assert.doesNotThrow(() => canonicalLegacyImportJson(result));
});
