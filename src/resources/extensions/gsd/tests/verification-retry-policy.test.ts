// Project/App: gsd-pi
// File Purpose: Unit tests for auto-mode verification retry backoff decisions.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decideVerificationRetry,
  hashVerificationFailureContext,
  verificationRetryDelayMs,
  verificationRetryKey,
  VERIFICATION_RETRY_MAX_DELAY_MS,
} from "../auto/verification-retry-policy.ts";
import { formatFailureContext, formatFailureSignature } from "../verification-gate.ts";
import type { VerificationResult } from "../types.ts";

test("verificationRetryDelayMs uses exponential backoff with cap", () => {
  assert.deepEqual(verificationRetryDelayMs(1, () => 0.5), {
    delayMs: 2_000,
    baseDelayMs: 2_000,
  });
  assert.deepEqual(verificationRetryDelayMs(2, () => 0.5), {
    delayMs: 4_000,
    baseDelayMs: 4_000,
  });
  assert.deepEqual(verificationRetryDelayMs(3, () => 0.5), {
    delayMs: 8_000,
    baseDelayMs: 8_000,
  });
  assert.deepEqual(verificationRetryDelayMs(99, () => 0.5), {
    delayMs: VERIFICATION_RETRY_MAX_DELAY_MS,
    baseDelayMs: VERIFICATION_RETRY_MAX_DELAY_MS,
  });
});

test("decideVerificationRetry pauses on repeated failure context across attempts", () => {
  const failureContext = "lint failed\n";
  const firstDecision = decideVerificationRetry({
    unitType: "execute-task",
    retryInfo: {
      unitId: "M001/S01/T01",
      failureContext,
      attempt: 1,
    },
    previousFailureHash: undefined,
    random: () => 0.5,
  });

  assert.equal(firstDecision.action, "delay");
  assert.equal(firstDecision.failureHash, hashVerificationFailureContext(failureContext));

  const decision = decideVerificationRetry({
    unitType: "execute-task",
    retryInfo: {
      unitId: "M001/S01/T01",
      failureContext,
      attempt: 2,
    },
    previousFailureHash: firstDecision.failureHash,
    random: () => 0.5,
  });

  assert.deepEqual(decision, {
    action: "pause",
    reason: "duplicate-failure-context",
    key: verificationRetryKey("execute-task", "M001/S01/T01"),
    failureHash: firstDecision.failureHash,
  });
});

test("decideVerificationRetry delays changed failure context", () => {
  const decision = decideVerificationRetry({
    unitType: "execute-task",
    retryInfo: {
      unitId: "M001/S01/T01",
      failureContext: "test failed differently",
      attempt: 2,
    },
    previousFailureHash: hashVerificationFailureContext("test failed"),
    random: () => 0.5,
  });

  assert.equal(decision.action, "delay");
  assert.equal(decision.key, verificationRetryKey("execute-task", "M001/S01/T01"));
  assert.equal(decision.delayMs, 4_000);
  assert.equal(decision.baseDelayMs, 4_000);
});

test("decideVerificationRetry pauses duplicate host-check failures with volatile stderr", () => {
  const makeResult = (stderr: string): VerificationResult => ({
    passed: false,
    discoverySource: "package-json",
    timestamp: Date.now(),
    checks: [
      {
        command: "npm test",
        exitCode: 1,
        stdout: "",
        stderr,
        durationMs: 100,
      },
    ],
  });
  const first = makeResult("failed after 120ms in /tmp/gsd-a worker pid 101");
  const second = makeResult("failed after 133ms in /tmp/gsd-b worker pid 202");
  const firstContext = formatFailureContext(first);
  const secondContext = formatFailureContext(second);

  assert.notEqual(
    hashVerificationFailureContext(firstContext),
    hashVerificationFailureContext(secondContext),
  );

  const signature = formatFailureSignature(first);
  assert.equal(signature, "npm test#1");
  assert.equal(formatFailureSignature(second), signature);

  const failureHash = hashVerificationFailureContext(signature);
  const decision = decideVerificationRetry({
    unitType: "execute-task",
    retryInfo: {
      unitId: "M001/S01/T01",
      failureContext: secondContext,
      signature: formatFailureSignature(second),
      attempt: 2,
    },
    previousFailureHash: failureHash,
    random: () => 0.5,
  });

  assert.deepEqual(decision, {
    action: "pause",
    reason: "duplicate-failure-context",
    key: verificationRetryKey("execute-task", "M001/S01/T01"),
    failureHash,
  });
});

test("decideVerificationRetry pauses when retry context is missing", () => {
  assert.deepEqual(
    decideVerificationRetry({
      unitType: "execute-task",
      retryInfo: null,
      previousFailureHash: undefined,
    }),
    { action: "pause", reason: "missing-retry-context" },
  );
});
