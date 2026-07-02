import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UserTokenRecord {
  userId: string;
  revoked?: boolean;
}

export interface DeviceTokenRecord {
  userId: string;
  runtimeId: string;
  runtimeName?: string;
  revoked?: boolean;
}

export interface PairingCodeRecord {
  userId: string;
  expiresAt: number;
}

export interface DeviceTokenIssue {
  userId: string;
  runtimeId: string;
  deviceToken: string;
}

export interface AuthStoreSnapshot {
  version: 1;
  userTokens: Array<UserTokenRecord & SecretHashRecord>;
  deviceTokens: Array<DeviceTokenRecord & SecretHashRecord>;
  pairingCodes: Array<PairingCodeRecord & SecretHashRecord>;
}

export interface SecretHashRecord {
  secretHash: string;
  secretSalt: string;
}

export class InMemoryAuthStore {
  protected readonly userTokens = new Map<string, UserTokenRecord & SecretHashRecord>();
  protected readonly deviceTokens = new Map<string, DeviceTokenRecord & SecretHashRecord>();
  protected readonly pairingCodes = new Map<string, PairingCodeRecord & SecretHashRecord>();

  constructor(seedUserToken?: { token: string; userId: string }, snapshot?: AuthStoreSnapshot) {
    if (snapshot) this.loadSnapshot(snapshot);
    if (seedUserToken) this.addUserToken(seedUserToken.token, seedUserToken.userId);
  }

  addUserToken(token: string, userId: string): void {
    const existing = findSecretRecord(this.userTokens, token);
    if (existing?.userId === userId && !existing.revoked) return;
    const key = deriveSecretHash(token);
    this.userTokens.set(key.secretHash, { ...key, userId });
    this.afterMutation();
  }

  authenticateUser(token: string | undefined): string | null {
    if (!token) return null;
    const record = findSecretRecord(this.userTokens, token);
    if (!record || record.revoked) return null;
    return record.userId;
  }

  authenticateDevice(token: string | undefined): DeviceTokenRecord | null {
    if (!token) return null;
    const record = findSecretRecord(this.deviceTokens, token);
    if (!record || record.revoked) return null;
    return record;
  }

  createPairingCode(userId: string, ttlMs = 10 * 60 * 1000): { code: string; expiresAt: number } {
    this.sweepExpiredPairingCodes();
    // One live pairing code per user: a new code invalidates any prior un-redeemed
    // one, so the guessable set never grows beyond a single code per user (and the
    // per-exchange scrypt cost stays bounded).
    for (const [hash, record] of this.pairingCodes) {
      if (record.userId === userId) this.pairingCodes.delete(hash);
    }
    // 64 bits of entropy (16 hex chars). Endpoint-level request rate limiting is the
    // complementary defense and belongs at the HTTP layer, not here.
    const code = randomBytes(8).toString("hex").toUpperCase();
    const expiresAt = Date.now() + ttlMs;
    const key = deriveSecretHash(code);
    this.pairingCodes.set(key.secretHash, { ...key, userId, expiresAt });
    this.afterMutation();
    return { code, expiresAt };
  }

  exchangePairingCode(code: string, runtimeName?: string): DeviceTokenIssue {
    this.sweepExpiredPairingCodes();
    const normalized = code.trim().toUpperCase();
    const codeEntry = findSecretEntry(this.pairingCodes, normalized);
    if (!codeEntry || codeEntry[1].expiresAt < Date.now()) {
      if (codeEntry) this.pairingCodes.delete(codeEntry[0]);
      this.afterMutation();
      throw new Error("Pairing code is invalid or expired");
    }
    const [codeHash, record] = codeEntry;
    this.pairingCodes.delete(codeHash);
    const runtimeId = `rt_${randomUUID()}`;
    const deviceToken = `gsd_dev_${randomBytes(32).toString("hex")}`;
    const key = deriveSecretHash(deviceToken);
    this.deviceTokens.set(key.secretHash, { ...key, userId: record.userId, runtimeId, runtimeName });
    this.afterMutation();
    return { userId: record.userId, runtimeId, deviceToken };
  }

  revokeDeviceToken(deviceToken: string): boolean {
    const record = findSecretRecord(this.deviceTokens, deviceToken);
    if (!record) return false;
    record.revoked = true;
    this.afterMutation();
    return true;
  }

  snapshot(): AuthStoreSnapshot {
    return {
      version: 1,
      userTokens: Array.from(this.userTokens.values()),
      deviceTokens: Array.from(this.deviceTokens.values()),
      pairingCodes: Array.from(this.pairingCodes.values()),
    };
  }

  protected afterMutation(): void {
    // Extension point for persistent stores.
  }

  // Drop expired pairing codes so a long-lived gateway does not accumulate codes
  // that were generated but never redeemed. Best-effort: callers persist via their
  // own afterMutation() after the create/exchange that triggered the sweep.
  private sweepExpiredPairingCodes(now = Date.now()): void {
    for (const [hash, record] of this.pairingCodes) {
      if (record.expiresAt < now) this.pairingCodes.delete(hash);
    }
  }

  private loadSnapshot(snapshot: AuthStoreSnapshot): void {
    for (const record of snapshot.userTokens ?? []) {
      this.userTokens.set(record.secretHash, record);
    }
    for (const record of snapshot.deviceTokens ?? []) {
      this.deviceTokens.set(record.secretHash, record);
    }
    for (const record of snapshot.pairingCodes ?? []) {
      if (record.expiresAt >= Date.now()) {
        this.pairingCodes.set(record.secretHash, record);
      }
    }
  }
}

export class FileAuthStore extends InMemoryAuthStore {
  private readonly filePath: string;

  constructor(
    filePath: string,
    seedUserToken?: { token: string; userId: string },
  ) {
    super(undefined, readSnapshot(filePath));
    this.filePath = filePath;
    if (seedUserToken) this.addUserToken(seedUserToken.token, seedUserToken.userId);
    this.persist();
  }

  protected override afterMutation(): void {
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length <= "Bearer ".length) return undefined;
  if (value.slice(0, "Bearer".length).toLowerCase() !== "bearer") return undefined;

  const firstSeparator = value.charCodeAt("Bearer".length);
  if (firstSeparator !== 0x20 && firstSeparator !== 0x09) return undefined;

  let tokenStart = "Bearer".length + 1;
  while (tokenStart < value.length) {
    const char = value.charCodeAt(tokenStart);
    if (char !== 0x20 && char !== 0x09) break;
    tokenStart += 1;
  }

  return tokenStart < value.length ? value.slice(tokenStart) : undefined;
}

export function deriveSecretHash(secret: string, secretSalt = randomBytes(16).toString("hex")): SecretHashRecord {
  return {
    secretHash: scryptSync(secret, secretSalt, 32).toString("hex"),
    secretSalt,
  };
}

function findSecretRecord<T extends SecretHashRecord>(records: Map<string, T>, secret: string): T | undefined {
  return findSecretEntry(records, secret)?.[1];
}

function findSecretEntry<T extends SecretHashRecord>(records: Map<string, T>, secret: string): [string, T] | undefined {
  for (const entry of records) {
    if (secretMatches(entry[1], secret)) return entry;
  }
  return undefined;
}

function secretMatches(record: SecretHashRecord, secret: string): boolean {
  const candidate = Buffer.from(deriveSecretHash(secret, record.secretSalt).secretHash, "hex");
  const expected = Buffer.from(record.secretHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function readSnapshot(filePath: string): AuthStoreSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AuthStoreSnapshot>;
    if (parsed.version !== 1) return undefined;
    return {
      version: 1,
      userTokens: Array.isArray(parsed.userTokens) ? parsed.userTokens as AuthStoreSnapshot["userTokens"] : [],
      deviceTokens: Array.isArray(parsed.deviceTokens) ? parsed.deviceTokens as AuthStoreSnapshot["deviceTokens"] : [],
      pairingCodes: Array.isArray(parsed.pairingCodes) ? parsed.pairingCodes as AuthStoreSnapshot["pairingCodes"] : [],
    };
  } catch {
    return undefined;
  }
}
