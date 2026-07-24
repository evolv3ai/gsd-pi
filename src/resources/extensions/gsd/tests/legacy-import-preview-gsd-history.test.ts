// Project/App: gsd-pi
// File Purpose: Intent tests for pure captured-byte workflow history interpretation.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { interpretLegacyGsdHistory } from "../legacy-import-preview-gsd-history.ts";
import {
  decodeLegacyImportCapture,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
} from "../legacy-import-preview-interpretation.ts";
import {
  captureLegacyImportSourceSet,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";

function capturedFiles(
  t: { after(fn: () => void): void },
  files: Readonly<Record<string, string | Uint8Array>>,
  worktreeFiles: Readonly<Record<string, string | Uint8Array>> = {},
) {
  const base = mkdtempSync(join(tmpdir(), "gsd-history-preview-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, ".gsd");
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  const roots: LegacyImportSourceRoot[] = [
    { id: "gsd", kind: "project", physical_path: root, logical_path: ".gsd", presence: "required" },
  ];
  if (Object.keys(worktreeFiles).length > 0) {
    const worktreeRoot = join(base, "worktree");
    for (const [path, content] of Object.entries(worktreeFiles)) {
      const destination = join(worktreeRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    roots.push({
      id: "worktree",
      kind: "worktree",
      physical_path: worktreeRoot,
      logical_path: ".gsd-worktrees/M001/.gsd",
      presence: "required",
    });
  }
  const capture = captureLegacyImportSourceSet({ roots });
  return decodeLegacyImportCapture(capture, {
    sourceLabel: "history test",
    includes: () => true,
    parserId: () => "unclassified",
    kind: () => "text",
    parserVersion: "0",
  });
}

function interpret(files: ReturnType<typeof capturedFiles>) {
  const candidates: LegacyImportPendingCandidate[] = [];
  const diagnoses: LegacyImportPendingDiagnosis[] = [];
  interpretLegacyGsdHistory(files, candidates, diagnoses);
  return { candidates, diagnoses };
}

describe("legacy GSD workflow history contribution", () => {
  test("preserves valid events in file order without replay, deduplication, or secret disclosure", (t) => {
    const lines = [
      { cmd: "plan_milestone", params: { milestoneId: "M001" }, ts: "2025-01-01T00:00:00.000Z", hash: "same", actor: "agent", session_id: "s" },
      { v: 2, cmd: "complete-task", params: { milestoneId: "M001", sliceId: "S01", taskId: "T01", authorityContext: "adopted" }, ts: "2025-01-01T00:02:00.000Z", hash: "same", actor: "agent", session_id: "s" },
      { v: 2, cmd: "start-task", params: { milestoneId: "M001", sliceId: "S01", taskId: "T02" }, ts: "2025-01-01T00:01:00.000Z", hash: "later", actor: "agent", session_id: "s" },
      { v: 2, cmd: "future-command", params: { milestoneId: "M099" }, ts: "2025-01-01T00:03:00.000Z", hash: "future", actor: "system", session_id: "s" },
      { v: 2, cmd: "report-blocker", params: { taskId: "T03", note: "Authorization: Bearer fixture-token-1234" }, ts: "2025-01-01T00:04:00.000Z", hash: "secret", actor: "agent", session_id: "s" },
    ].map((event) => JSON.stringify(event));
    const files = capturedFiles(t, { "event-log.jsonl": `${lines.join("\n")}\n` });
    const { candidates, diagnoses } = interpret(files);

    assert.deepEqual(candidates.map((candidate) => ({
      target: candidate.target,
      normalized: candidate.normalized,
      reason: candidate.reason_code,
    })), [
      {
        target: { kind: "legacy-workflow-event", key: ".gsd/event-log.jsonl#L001" },
        normalized: { replay_policy: "evidence-only", event_version: 1, command: "plan_milestone", entity: { type: "milestone", id: "M001" }, authority_context: null, file_order: 1 },
        reason: "history-evidence-only",
      },
      {
        target: { kind: "legacy-workflow-event", key: ".gsd/event-log.jsonl#L002" },
        normalized: { replay_policy: "evidence-only", event_version: 2, command: "complete_task", entity: { type: "task", id: "T01" }, authority_context: "adopted", file_order: 2 },
        reason: "duplicate-history-evidence-preserved",
      },
      {
        target: { kind: "legacy-workflow-event", key: ".gsd/event-log.jsonl#L003" },
        normalized: { replay_policy: "evidence-only", event_version: 2, command: "start_task", entity: { type: "task", id: "T02" }, authority_context: null, file_order: 3 },
        reason: "out-of-order-history-evidence-preserved",
      },
      {
        target: { kind: "legacy-workflow-event", key: ".gsd/event-log.jsonl#L004" },
        normalized: { replay_policy: "evidence-only", event_version: 2, command: "future_command", entity: null, authority_context: null, file_order: 4 },
        reason: "unknown-history-event-preserved",
      },
    ]);
    assert.deepEqual(diagnoses.map((diagnosis) => diagnosis.code).sort(), [
      "duplicate-event-hash",
      "out-of-order-event",
      "secret-shaped-history-evidence",
      "unknown-workflow-command",
    ]);
    const secret = diagnoses.find((diagnosis) => diagnosis.code === "secret-shaped-history-evidence");
    assert.deepEqual(secret?.raw_value && typeof secret.raw_value === "object" ? Object.keys(secret.raw_value).sort() : [], ["redacted", "sha256"]);
    assert.ok(!JSON.stringify(secret).includes("fixture-token-1234"));
    assert.equal(files[0]?.parserId, "gsd-workflow-events");
    assert.equal(files[0]?.outcome, "preserved");
  });

  test("classifies archived evidence and fails loud on corrupt JSONL bytes", (t) => {
    const archived = JSON.stringify({ cmd: "complete_slice", params: { sliceId: "S01" }, ts: "2025-01-01T00:00:00.000Z", hash: "h", actor: "agent", session_id: "s" });
    const files = capturedFiles(t, {
      "event-log-M001.jsonl.archived": `${archived}\n`,
      "event-log-M999.jsonl.archived": "{\"cmd\":\"complete-task\"\n",
      "doctor-history.jsonl": "{\"status\":\"ok\"}\n",
    });
    const { candidates, diagnoses } = interpret(files);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.reason_code, "archived-history-evidence-only");
    assert.equal(candidates[0]?.raw.value, archived);
    assert.ok(diagnoses.some((diagnosis) => diagnosis.code === "corrupt-jsonl-line"));
    assert.ok(diagnoses.some((diagnosis) => diagnosis.code === "non-workflow-jsonl-excluded"));
    assert.equal(files.find((file) => file.entry.logical_path.includes("M999"))?.outcome, "unparsed");
  });

  test("ignores embedded blank rows and rejects malformed valid-JSON event shapes", (t) => {
    const valid = JSON.stringify({
      cmd: "complete_task",
      params: { taskId: "T01" },
      ts: "2025-01-01T00:00:00.000Z",
      hash: "valid",
      actor: "agent",
      session_id: "session",
    });
    const malformed = JSON.stringify({
      cmd: "complete_task",
      params: [],
      ts: "2025-01-01T00:01:00.000Z",
      hash: "malformed",
      actor: "agent",
      session_id: "session",
    });
    const files = capturedFiles(t, {
      "event-log.jsonl": `${valid}\n\n   \t\n${malformed}\n`,
    });
    const { candidates, diagnoses } = interpret(files);

    assert.deepEqual(candidates.map((candidate) => candidate.target.key), [
      ".gsd/event-log.jsonl#L001",
    ]);
    assert.deepEqual(diagnoses.map((diagnosis) => diagnosis.code), [
      "malformed-workflow-event",
    ]);
    assert.equal(diagnoses[0]?.locator.line, 4);
    assert.equal(files[0]?.outcome, "unparsed");
  });

  test("fails loud on an invalid UTF-8 workflow ledger", (t) => {
    const files = capturedFiles(t, {
      "event-log.jsonl": Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a]),
    });
    const { candidates, diagnoses } = interpret(files);

    assert.equal(candidates.length, 0);
    assert.deepEqual(diagnoses.map((diagnosis) => diagnosis.code), [
      "unsupported-workflow-history-encoding",
    ]);
    assert.equal(files[0]?.encoding, "binary");
    assert.equal(files[0]?.outcome, "unparsed");
  });

  test("compares fork history by parsed event order while retaining physical line provenance", (t) => {
    const first = JSON.stringify({
      cmd: "complete_task",
      params: { taskId: "T01" },
      ts: "2025-01-01T00:00:00.000Z",
      hash: "shared-first",
      actor: "agent",
      session_id: "session",
    });
    const second = JSON.stringify({
      cmd: "complete_task",
      params: { taskId: "T02" },
      ts: "2025-01-01T00:01:00.000Z",
      hash: "shared-second",
      actor: "agent",
      session_id: "session",
    });
    const files = capturedFiles(
      t,
      { "event-log.jsonl": `${first}\n${second}\n` },
      { "event-log.jsonl": `${first}\n  \t\n${second}\n` },
    );
    const { candidates, diagnoses } = interpret(files);
    const worktree = files.find((file) => file.entry.logical_path.startsWith(".gsd-worktrees/"));
    const worktreeCandidates = candidates.filter((candidate) => candidate.raw.source_id === worktree?.entry.source_id);

    assert.deepEqual(worktreeCandidates.map((candidate) => ({
      key: candidate.target.key,
      normalized: candidate.normalized,
      reason: candidate.reason_code,
    })), [
      {
        key: ".gsd-worktrees/M001/.gsd/event-log.jsonl#L001",
        normalized: {
          replay_policy: "evidence-only",
          event_version: 1,
          command: "complete_task",
          entity: { type: "task", id: "T01" },
          authority_context: null,
          file_order: 1,
        },
        reason: "fork-base-history-preserved",
      },
      {
        key: ".gsd-worktrees/M001/.gsd/event-log.jsonl#L003",
        normalized: {
          replay_policy: "evidence-only",
          event_version: 1,
          command: "complete_task",
          entity: { type: "task", id: "T02" },
          authority_context: null,
          file_order: 3,
        },
        reason: "fork-base-history-preserved",
      },
    ]);
    assert.equal(diagnoses.some((diagnosis) => diagnosis.code === "history-fork-preserved"), false);
  });
});
