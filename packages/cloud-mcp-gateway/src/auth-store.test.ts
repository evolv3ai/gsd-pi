import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileAuthStore, InMemoryAuthStore, extractBearerToken } from "./auth-store.js";

test("auth rejects missing, invalid, and revoked device tokens", () => {
  const auth = new InMemoryAuthStore({ token: "user-token", userId: "u1" });
  assert.equal(auth.authenticateUser(undefined), null);
  assert.equal(auth.authenticateUser("bad"), null);
  assert.equal(auth.authenticateUser("user-token"), "u1");

  const { code } = auth.createPairingCode("u1");
  const issued = auth.exchangePairingCode(code, "MacBook");
  assert.equal(auth.authenticateDevice("bad"), null);
  assert.equal(auth.authenticateDevice(issued.deviceToken)?.runtimeId, issued.runtimeId);
  assert.equal(auth.revokeDeviceToken(issued.deviceToken), true);
  assert.equal(auth.authenticateDevice(issued.deviceToken), null);
});

test("pairing code is one-time use", () => {
  const auth = new InMemoryAuthStore({ token: "user-token", userId: "u1" });
  const { code } = auth.createPairingCode("u1");
  auth.exchangePairingCode(code);
  assert.throws(() => auth.exchangePairingCode(code), /invalid or expired/);
});

test("extractBearerToken parses bearer auth header", () => {
  assert.equal(extractBearerToken("Bearer abc"), "abc");
  assert.equal(extractBearerToken("bearer abc"), "abc");
  assert.equal(extractBearerToken("Bearer\t\tabc"), "abc");
  assert.equal(extractBearerToken("Basic abc"), undefined);
  assert.equal(extractBearerToken(`bearer\t${"\t".repeat(10_000)}`), undefined);
});

test("file auth store persists user and device auth without raw tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-auth-"));
  const storePath = join(dir, "auth.json");
  const first = new FileAuthStore(storePath, { token: "user-token", userId: "u1" });
  assert.equal(first.authenticateUser("user-token"), "u1");

  const { code } = first.createPairingCode("u1");
  const issued = first.exchangePairingCode(code, "Laptop");
  assert.equal(first.authenticateDevice(issued.deviceToken)?.runtimeName, "Laptop");

  const raw = readFileSync(storePath, "utf8");
  assert.doesNotMatch(raw, /user-token/);
  assert.doesNotMatch(raw, new RegExp(issued.deviceToken));
  assert.doesNotMatch(raw, new RegExp(code));
  const snapshot = JSON.parse(raw) as { userTokens: Array<Record<string, unknown>> };
  assert.equal(typeof snapshot.userTokens[0]?.secretSalt, "string");
  assert.equal(typeof snapshot.userTokens[0]?.secretHash, "string");
  assert.equal(snapshot.userTokens[0]?.tokenHash, undefined);

  const second = new FileAuthStore(storePath);
  assert.equal(second.authenticateUser("user-token"), "u1");
  assert.equal(second.authenticateDevice(issued.deviceToken)?.runtimeId, issued.runtimeId);

  assert.equal(second.revokeDeviceToken(issued.deviceToken), true);
  const third = new FileAuthStore(storePath);
  assert.equal(third.authenticateDevice(issued.deviceToken), null);
});

test("file auth store preserves unexchanged pairing codes across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-pairing-"));
  const storePath = join(dir, "auth.json");
  const first = new FileAuthStore(storePath, { token: "user-token", userId: "u1" });
  const { code } = first.createPairingCode("u1");

  const second = new FileAuthStore(storePath);
  const issued = second.exchangePairingCode(code, "Laptop");
  assert.equal(second.authenticateDevice(issued.deviceToken)?.runtimeName, "Laptop");
});
