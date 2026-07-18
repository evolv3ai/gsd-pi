import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** F5.1-2 sign-off hardening: sign-off requires a single-use token that only
 *  the CONSOLE command surface prints to the human. The tool surface never
 *  mints or returns one, so an agent cannot self-authorize by flipping a
 *  boolean (e2e F-5.1). Only the sha256 of the token touches disk. */

export const APPROVAL_TOKEN_TTL_MS = 30 * 60 * 1000;

export type TokenVerdict = "ok" | "no-pending" | "mismatch" | "expired" | "stale-map";

interface PendingApproval {
  schemaVersion: 1;
  tokenHash: string;
  approvalHash: string;
  issuedAt: string;
}

export function pendingApprovalPath(projectRoot: string): string {
  return join(projectRoot, ".gsd", "planf3-gsd-pending-approval.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function issueApprovalToken(
  projectRoot: string,
  approvalHash: string,
  opts?: { now?: () => Date },
): Promise<string> {
  const now = opts?.now ?? (() => new Date());
  const token = randomBytes(8).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 10);
  const pending: PendingApproval = {
    schemaVersion: 1,
    tokenHash: hashToken(token),
    approvalHash,
    issuedAt: now().toISOString(),
  };
  const path = pendingApprovalPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(pending, null, 2) + "\n", "utf8");
  return token;
}

export async function consumeApprovalToken(
  projectRoot: string,
  token: string,
  approvalHash: string,
  opts?: { now?: () => Date },
): Promise<TokenVerdict> {
  const now = opts?.now ?? (() => new Date());
  const path = pendingApprovalPath(projectRoot);
  let pending: PendingApproval;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PendingApproval;
    if (parsed.schemaVersion !== 1 || typeof parsed.tokenHash !== "string") return "no-pending";
    pending = parsed;
  } catch {
    return "no-pending";
  }
  const supplied = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(pending.tokenHash, "hex");
  if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return "mismatch";
  if (pending.approvalHash !== approvalHash) return "stale-map";
  if (now().getTime() - Date.parse(pending.issuedAt) > APPROVAL_TOKEN_TTL_MS) return "expired";
  await rm(path, { force: true });
  return "ok";
}
