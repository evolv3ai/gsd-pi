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
  readPendingProjectedFrom,
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
    const pending = JSON.parse(raw) as { schemaVersion: number; tokenHash: string; approvalHash: string; projectedFrom: string | null; issuedAt: string };
    assert.equal(pending.schemaVersion, 2);
    assert.equal(pending.projectedFrom, null); // bare mint defaults to bare scope
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

describe("path-bound approval token (F6.0-6)", () => {
  const SCOPE = "/abs/specs/p.html";

  test("issue persists projectedFrom; readPendingProjectedFrom returns it", async () => {
    const tmp = await scaffold();
    await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-20T12:00:00Z"), projectedFrom: SCOPE });
    const raw = await readFile(pendingApprovalPath(tmp), "utf8");
    assert.equal((JSON.parse(raw) as { projectedFrom: string | null }).projectedFrom, SCOPE);
    assert.equal(await readPendingProjectedFrom(tmp), SCOPE);
  });

  test("readPendingProjectedFrom: bare scope and missing file both → null", async () => {
    const tmp = await scaffold();
    assert.equal(await readPendingProjectedFrom(tmp), null); // no pending file
    await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-20T12:00:00Z") });
    assert.equal(await readPendingProjectedFrom(tmp), null); // bare scope
  });

  test("bare consumption of a path-scoped token → path-mismatch, token SURVIVES, correct retry → ok", async () => {
    const tmp = await scaffold();
    const token = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-20T12:00:00Z"), projectedFrom: SCOPE });
    const bare = await consumeApprovalToken(tmp, token, HASH_A, { now: clock("2026-07-20T12:01:00Z") });
    assert.equal(bare, "path-mismatch");
    await access(pendingApprovalPath(tmp)); // NOT consumed — the human retries with the path
    const retry = await consumeApprovalToken(tmp, token, HASH_A, { now: clock("2026-07-20T12:02:00Z"), projectedFrom: SCOPE });
    assert.equal(retry, "ok");
  });

  test("path-scoped consumption of a bare token → path-mismatch (asymmetric direction also refused)", async () => {
    const tmp = await scaffold();
    const token = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-20T12:00:00Z") });
    const verdict = await consumeApprovalToken(tmp, token, HASH_A, { now: clock("2026-07-20T12:01:00Z"), projectedFrom: SCOPE });
    assert.equal(verdict, "path-mismatch");
    await access(pendingApprovalPath(tmp));
  });

  test("wrong path → path-mismatch (even when the map hash ALSO differs — path wins); right path → ok and pending record deleted", async () => {
    const tmp = await scaffold();
    const token = await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-20T12:00:00Z"), projectedFrom: SCOPE });
    assert.equal(
      await consumeApprovalToken(tmp, token, HASH_B, { now: clock("2026-07-20T12:01:00Z"), projectedFrom: "/abs/specs/other.html" }),
      "path-mismatch", // precedence pin: path-mismatch fires before stale-map
    );
    assert.equal(
      await consumeApprovalToken(tmp, token, HASH_A, { now: clock("2026-07-20T12:01:30Z"), projectedFrom: "/abs/specs/other.html" }),
      "path-mismatch",
    );
    assert.equal(
      await consumeApprovalToken(tmp, token, HASH_A, { now: clock("2026-07-20T12:02:00Z"), projectedFrom: SCOPE }),
      "ok",
    );
    await assert.rejects(access(pendingApprovalPath(tmp)));
  });

  test("a v1 pending file (pre-0.6.1) is no-pending — TTL makes migration moot", async () => {
    const tmp = await scaffold();
    await issueApprovalToken(tmp, HASH_A, { now: clock("2026-07-20T12:00:00Z") });
    const raw = JSON.parse(await readFile(pendingApprovalPath(tmp), "utf8")) as Record<string, unknown>;
    raw.schemaVersion = 1;
    delete raw.projectedFrom;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(pendingApprovalPath(tmp), JSON.stringify(raw), "utf8");
    assert.equal(await consumeApprovalToken(tmp, "anytoken00", HASH_A, { now: clock("2026-07-20T12:01:00Z") }), "no-pending");
  });
});
