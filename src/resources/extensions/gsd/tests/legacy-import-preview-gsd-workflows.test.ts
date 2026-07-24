// Project/App: gsd-pi
// File Purpose: Intent tests for pure captured-byte workflow definition and run interpretation.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { interpretLegacyGsdWorkflows } from "../legacy-import-preview-gsd-workflows.ts";
import {
  decodeLegacyImportCapture,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "../legacy-import-preview-interpretation.ts";
import { captureLegacyImportSourceSet, type LegacyImportSourceRoot } from "../legacy-import-preview-source.ts";

function capturedFiles(
  t: { after(fn: () => void): void },
  roots: Readonly<Record<string, Readonly<Record<string, string | Uint8Array>>>>,
) {
  const base = mkdtempSync(join(tmpdir(), "gsd-workflow-preview-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sourceRoots: LegacyImportSourceRoot[] = [];
  for (const [logicalRoot, files] of Object.entries(roots)) {
    const root = join(base, logicalRoot.replace(/[^a-z0-9]+/giu, "-") || "root");
    for (const [path, content] of Object.entries(files)) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    sourceRoots.push({
      id: `root-${sourceRoots.length + 1}`,
      kind: logicalRoot === ".gsd" ? "project" : "external",
      physical_path: root,
      logical_path: logicalRoot,
      presence: "required",
    });
  }
  const capture = captureLegacyImportSourceSet({ roots: sourceRoots });
  return decodeLegacyImportCapture(capture, {
    sourceLabel: "workflow test",
    includes: () => true,
    parserId: () => "unclassified",
    kind: () => "text",
    parserVersion: "0",
  });
}

function interpret(files: ReturnType<typeof capturedFiles>, bundledDefinitionNames: readonly string[] = []) {
  const candidates: LegacyImportPendingCandidate[] = [];
  const diagnoses: LegacyImportPendingDiagnosis[] = [];
  interpretLegacyGsdWorkflows(files, candidates, diagnoses, { bundledDefinitionNames });
  return { candidates, diagnoses };
}

const currentDefinition = `version: 1
name: collision
steps:
  - id: inspect
    name: Inspect
    prompt: Inspect current evidence.
`;

describe("legacy GSD workflow definition and run contribution", () => {
  test("resolves captured definition precedence and preserves winners verbatim", (t) => {
    const files = capturedFiles(t, {
      ".gsd": {
        "workflows/collision.yaml": currentDefinition,
        "workflow-defs/collision.yaml": currentDefinition.replace("current", "legacy"),
        "workflows/bugfix.md": "# Project Bugfix\n\n<template_meta>\nmode: markdown-phase\n</template_meta>\n",
        "workflows/schema-invalid.yaml": currentDefinition.replace("version: 1", "version: 2"),
      },
      "gsd-home": {
        "workflows/collision.yaml": currentDefinition.replace("current", "global"),
        "workflows/global-only.yml": currentDefinition.replaceAll("collision", "global-only"),
      },
    });
    const { candidates, diagnoses } = interpret(files, ["bugfix"]);

    assert.deepEqual(candidates.map((candidate) => candidate.target.key).sort(), [
      ".gsd/workflows/bugfix.md",
      ".gsd/workflows/collision.yaml",
      "gsd-home/workflows/global-only.yml",
    ]);
    assert.ok(candidates.every((candidate) => (
      candidate.target.kind === "legacy-workflow-definition"
      && candidate.reason_code === "workflow-definition-is-evidence-only"
      && typeof candidate.normalized === "object"
      && candidate.normalized !== null
      && "preservation" in candidate.normalized
      && candidate.normalized.preservation === "verbatim"
    )));
    assert.deepEqual(diagnoses.map((diagnosis) => diagnosis.code).sort(), [
      "lower-precedence-workflow-ignored",
      "lower-precedence-workflow-ignored",
      "lower-precedence-workflow-shadowed",
      "unsupported-workflow-definition-version",
    ]);
    assert.deepEqual(
      diagnoses.filter((diagnosis) => diagnosis.code === "lower-precedence-workflow-ignored")
        .map((diagnosis) => diagnosis.raw_value),
      ["collision", "collision"],
    );
    assert.equal(
      diagnoses.find((diagnosis) => diagnosis.code === "lower-precedence-workflow-shadowed")?.raw_value,
      "Project Bugfix",
    );
    assert.equal(
      diagnoses.find((diagnosis) => diagnosis.code === "unsupported-workflow-definition-version")?.raw_value,
      "version: 2",
    );
    assert.equal(files.find((file) => file.entry.logical_path.includes("schema-invalid"))?.outcome, "unparsed");
  });

  test("groups run artifacts without resuming, preserves independent evidence, and redacts parameter diagnostics", (t) => {
    const graph = `steps:
  - id: inspect
    title: Inspect
    status: active
    prompt: Inspect evidence.
metadata:
  name: partial
  created_at: 2026-01-01T00:00:00.000Z
`;
    const files = capturedFiles(t, {
      ".gsd": {
        "workflows/partial.yaml": currentDefinition.replaceAll("collision", "partial"),
        "workflow-runs/partial/run-001/DEFINITION.yaml": currentDefinition.replaceAll("collision", "partial").replace("current", "frozen"),
        "workflow-runs/partial/run-001/GRAPH.yaml": graph,
        "workflow-runs/partial/run-001/PARAMS.json": "{\n  \"api_token\": \"synthetic-token-workflow-2026\"\n}\n",
        "workflow-runs/missing/run-002/DEFINITION.yaml": currentDefinition.replaceAll("collision", "missing"),
        "workflow-runs/unknown/run-003/DEFINITION.yaml": currentDefinition.replaceAll("collision", "unknown"),
        "workflow-runs/unknown/run-003/GRAPH.yaml": graph.replace("name: partial", "name: unknown").replace("status: active", "status: paused"),
      },
    });
    const { candidates, diagnoses } = interpret(files);
    const runCandidates = candidates.filter((candidate) => candidate.target.kind === "legacy-workflow-run-artifact");

    assert.deepEqual(runCandidates.map((candidate) => candidate.target.key).sort(), [
      ".gsd/workflow-runs/missing/run-002/DEFINITION.yaml",
      ".gsd/workflow-runs/partial/run-001/DEFINITION.yaml",
      ".gsd/workflow-runs/partial/run-001/GRAPH.yaml",
      ".gsd/workflow-runs/partial/run-001/PARAMS.json",
      ".gsd/workflow-runs/unknown/run-003/DEFINITION.yaml",
    ]);
    assert.ok(runCandidates.every((candidate) => candidate.reason_code === "workflow-run-is-evidence-only"));
    assert.ok(diagnoses.some((diagnosis) => diagnosis.code === "workflow-definition-drift"));
    assert.ok(diagnoses.some((diagnosis) => diagnosis.code === "missing-workflow-graph"));
    assert.ok(diagnoses.some((diagnosis) => diagnosis.code === "unknown-workflow-step-status"));
    assert.equal(
      diagnoses.find((diagnosis) => diagnosis.code === "workflow-definition-drift")?.raw_value,
      "Inspect frozen evidence.",
    );
    assert.equal(
      diagnoses.find((diagnosis) => diagnosis.code === "missing-workflow-graph")?.raw_value,
      "name: missing",
    );
    assert.equal(
      diagnoses.find((diagnosis) => diagnosis.code === "unknown-workflow-step-status")?.raw_value,
      "paused",
    );
    const sensitive = diagnoses.find((diagnosis) => diagnosis.code === "sensitive-workflow-parameter");
    assert.equal(sensitive?.locator.json_pointer, "/api_token");
    assert.ok(!JSON.stringify(sensitive).includes("synthetic-token-workflow-2026"));
    assert.equal(files.find((file) => file.entry.logical_path.endsWith("run-003/GRAPH.yaml"))?.outcome, "unparsed");
  });

  test("blocks same-tier workflow definition ambiguity", (t) => {
    const files = capturedFiles(t, {
      ".gsd": {
        "workflows/collision.yaml": currentDefinition,
        "workflows/collision.yml": currentDefinition.replace("current", "alternate"),
      },
    });
    const { candidates, diagnoses } = interpret(files);

    assert.equal(candidates.length, 0);
    assert.equal(diagnoses.length, 2);
    assert.ok(diagnoses.every((diagnosis) => (
      diagnosis.code === "ambiguous-workflow-definition"
      && diagnosis.severity === "blocker"
      && diagnosis.resolution.disposition === "requires-user"
    )));
    assert.ok(files.every((file) => file.outcome === "unparsed"));
  });

  test("fails loud on malformed workflow parameters", (t) => {
    const files = capturedFiles(t, {
      ".gsd": {
        "workflow-runs/partial/run-malformed/PARAMS.json": "{\n  \"mode\": \"inspect\"\n",
      },
    });
    const { candidates, diagnoses } = interpret(files);

    assert.equal(candidates.length, 0);
    assert.deepEqual(diagnoses.map((diagnosis) => diagnosis.code), [
      "malformed-workflow-parameters",
    ]);
    assert.equal(files[0]?.outcome, "unparsed");
  });

  test("fails loud on non-UTF-8 workflow run artifacts", (t) => {
    const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0x00]);
    const files = capturedFiles(t, {
      ".gsd": {
        "workflow-runs/partial/run-binary/DEFINITION.yaml": invalidUtf8,
        "workflow-runs/partial/run-binary/GRAPH.yaml": invalidUtf8,
        "workflow-runs/partial/run-binary/PARAMS.json": invalidUtf8,
      },
    });
    const { candidates, diagnoses } = interpret(files);

    assert.equal(candidates.length, 0);
    assert.equal(diagnoses.length, 3);
    assert.ok(diagnoses.every((diagnosis) => diagnosis.code === "unsupported-workflow-run-encoding"));
    assert.ok(files.every((file) => file.encoding === "binary" && file.outcome === "unparsed"));
  });
});
