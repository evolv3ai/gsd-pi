// GSD Extension — Guidance module tests
// The catalog is the test surface: every typed finding must resolve to
// non-empty remediation, and load-bearing phrases must survive edits.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  formatGuidance,
  recoveryRemediation,
  needsAttentionBlockerGuidance,
  needsRemediationBlockerGuidance,
  crashResumeHint,
  doctorFixHint,
  type RecoveryGuidanceKey,
} from "../guidance.js";
import { classifyFailure, type RecoveryFailureKind } from "../recovery-classification.js";
import { isValidationBlockedState } from "../validation-block-guard.js";
import type { GSDState } from "../types.js";

const RECOVERY_KEYS: RecoveryGuidanceKey[] = [
  "tool-schema",
  "tool-contract",
  "tool-unavailable",
  "deterministic-policy",
  "lifecycle-progression",
  "stale-worker",
  "worktree-invalid",
  "verification-drift",
  "reconciliation-drift",
  "illegal-transition",
  "runtime-unknown",
  "provider-transient",
  "provider-permanent",
];

describe("guidance catalog", () => {
  test("every recovery guidance key resolves to non-empty remediation", () => {
    for (const key of RECOVERY_KEYS) {
      const remediation = recoveryRemediation(key);
      assert.ok(remediation.length > 0, `empty remediation for ${key}`);
    }
  });

  test("classifyFailure carries catalog remediation for every failure kind", () => {
    const kinds: RecoveryFailureKind[] = [
      "tool-schema",
      "tool-contract",
      "deterministic-policy",
      "lifecycle-progression",
      "stale-worker",
      "worktree-invalid",
      "verification-drift",
      "reconciliation-drift",
      "runtime-unknown",
    ];
    for (const kind of kinds) {
      const result = classifyFailure({ error: new Error("boom"), failureKind: kind });
      assert.equal(result.failureKind, kind);
      assert.equal(result.exitReason, kind);
      assert.ok(result.remediation.length > 0, `empty remediation for ${kind}`);
    }
  });

  test("escalation kinds with weak guidance now name a concrete command", () => {
    for (const key of ["stale-worker", "worktree-invalid", "verification-drift", "reconciliation-drift"] as const) {
      assert.match(recoveryRemediation(key), /\/gsd /, `no command in remediation for ${key}`);
    }
  });

  test("formatGuidance numbers steps under the summary", () => {
    const text = formatGuidance({ summary: "It broke.", steps: ["Fix it.", "Retry."] });
    assert.equal(text, "It broke.\n\n1. Fix it.\n2. Retry.");
  });

  test("formatGuidance with no steps is just the summary", () => {
    assert.equal(formatGuidance({ summary: "All good.", steps: [] }), "All good.");
  });
});

describe("milestone blocker guidance", () => {
  test("needs-attention blocker keeps the phrase the validation-block guard matches", () => {
    const state = { phase: "blocked", blockers: [needsAttentionBlockerGuidance("M005")] } as unknown as GSDState;
    assert.ok(isValidationBlockedState(state));
  });

  test("needs-remediation blocker keeps the phrase the validation-block guard matches", () => {
    const state = { phase: "blocked", blockers: [needsRemediationBlockerGuidance("M005")] } as unknown as GSDState;
    assert.ok(isValidationBlockedState(state));
  });

  test("blockers carry the milestone id and concrete fix commands", () => {
    const text = needsAttentionBlockerGuidance("M007");
    assert.match(text, /M007/);
    assert.match(text, /\/gsd status/);
    assert.match(text, /\/gsd validate-milestone/);
  });
});

describe("crash resume hints", () => {
  test("bootstrap crash reports no work lost", () => {
    assert.match(crashResumeHint("starting", "bootstrap") ?? "", /No work was lost/);
  });

  test("unit classes map to their resume hints", () => {
    assert.match(crashResumeHint("research-milestone", "M001") ?? "", /may be incomplete/);
    assert.match(crashResumeHint("execute-task", "T001") ?? "", /completed work is preserved/);
    assert.match(crashResumeHint("complete-slice", "S001") ?? "", /interrupted/);
  });

  test("unknown unit types yield no hint", () => {
    assert.equal(crashResumeHint("triage-captures", "X"), undefined);
  });
});

describe("doctor fix hints", () => {
  test("known codes resolve to a hint", () => {
    assert.ok(doctorFixHint("stale_crash_lock"));
    assert.ok(doctorFixHint("db_unavailable"));
  });

  test("codes without authored guidance resolve to undefined", () => {
    assert.equal(doctorFixHint("delimiter_in_title"), undefined);
  });
});
