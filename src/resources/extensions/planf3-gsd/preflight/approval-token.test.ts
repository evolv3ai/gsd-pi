import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  issueApprovalToken,
  consumeApprovalToken,
  pendingApprovalPath,
  APPROVAL_TOKEN_TTL_MS,
} from "./approval-token.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function scaffold(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "planf3-token-"));
}

function clock(iso: string): () => Date {
  return () => new Date(iso);
}

describe("approval token issue/consume (F5.1-2 sign-off hardening)", () => {
  test("issue writes a hashed pending record (never the plaintext token) and returns the token", async () => {
    const tmp = await scaffold();
    const token = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T12:00:00Z") });
    assert.match(token, /^[a-z0-9]{10}$/, "human-typable token shape");
    const raw = await readFile(pendingApprovalPath(tmp), "utf8");
    const pending = JSON.parse(raw) as { schemaVersion: number; tokenHash: string; approvalHash: string; issuedAt: string };
    assert.equal(pending.schemaVersion, 1);
    assert.equal(pending.approvalHash, HASH_A);
    assert.equal(pending.issuedAt, "2026-07-18T12:00:00.000Z");
    assert.ok(!raw.includes(token), "plaintext token must never touch disk");
    assert.match(pending.tokenHash, /^[0-9a-f]{64}$/);
  });

  test("consume with the right token and same map hash succeeds once, then the pending record is gone", async () => {
    const tmp = await scaffold();
    const token = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T12:00:00Z") });
    const verdict = await consumeApprovalToken(tmp, token, HASH_A, { now: clock("2026-07-18T12:05:00Z") });
    assert.equal(verdict, "ok");
    await assert.rejects(access(pendingApprovalPath(tmp)), "single-use: pending record deleted on success");
    const second = await consumeApprovalToken(tmp, token, HASH_A, { now: clock("2026-07-18T12:06:00Z") });
    assert.equal(second, "no-pending");
  });

  test("wrong token is rejected and does NOT consume the pending record", async () => {
    const tmp = await scaffold();
    await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T12:00:00Z") });
    const verdict = await consumeApprovalToken(tmp, "0000000000", HASH_A, { now: clock("2026-07-18T12:01:00Z") });
    assert.equal(verdict, "mismatch");
    await access(pendingApprovalPath(tmp)); // still present — the human's token stays valid
  });

  test("token expires after the TTL", async () => {
    const tmp = await scaffold();
    const token = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T12:00:00Z") });
    const justInside = await consumeApprovalToken(tmp, token, HASH_A, {
      now: () => new Date(Date.parse("2026-07-18T12:00:00Z") + APPROVAL_TOKEN_TTL_MS - 1000),
    });
    assert.equal(justInside, "ok");
    const token2 = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T13:00:00Z") });
    const outside = await consumeApprovalToken(tmp, token2, HASH_A, {
      now: () => new Date(Date.parse("2026-07-18T13:00:00Z") + APPROVAL_TOKEN_TTL_MS + 1000),
    });
    assert.equal(outside, "expired");
  });

  test("map changed since issue (approvalHash differs) → stale-map, record kept", async () => {
    const tmp = await scaffold();
    const token = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T12:00:00Z") });
    const verdict = await consumeApprovalToken(tmp, token, HASH_B, { now: clock("2026-07-18T12:01:00Z") });
    assert.equal(verdict, "stale-map");
    await access(pendingApprovalPath(tmp));
  });

  test("no pending record → no-pending", async () => {
    const tmp = await scaffold();
    const verdict = await consumeApprovalToken(tmp, "abcdef1234", HASH_A, { now: clock("2026-07-18T12:00:00Z") });
    assert.equal(verdict, "no-pending");
  });

  test("re-issue overwrites the previous pending token (only the newest is valid)", async () => {
    const tmp = await scaffold();
    const first = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T12:00:00Z") });
    const second = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T12:01:00Z") });
    assert.notEqual(first, second);
    assert.equal(await consumeApprovalToken(tmp, first, HASH_A, { now: clock("2026-07-18T12:02:00Z") }), "mismatch");
    assert.equal(await consumeApprovalToken(tmp, second, HASH_A, { now: clock("2026-07-18T12:03:00Z") }), "ok");
  });

  test("corrupt pending file behaves as no-pending", async () => {
    const tmp = await scaffold();
    await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-18T12:00:00Z") });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(pendingApprovalPath(tmp), "{broken", "utf8");
    const verdict = await consumeApprovalToken(tmp, "abcdef1234", HASH_A, { now: clock("2026-07-18T12:01:00Z") });
    assert.equal(verdict, "no-pending");
  });
});
