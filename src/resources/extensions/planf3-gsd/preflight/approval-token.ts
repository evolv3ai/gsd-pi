import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** F5.1-2 sign-off hardening: sign-off requires a single-use token that only
 *  the CONSOLE command surface prints to the human. The tool surface never
 *  mints or returns one, so an agent cannot self-authorize by flipping a
 *  boolean (e2e F-5.1). Only the sha256 of the token touches disk.
 *
 *  F6.0-6: the token is scoped to the projection it was minted for
 *  (`projectedFrom`, resolved absolute path, null = bare map). Consuming with
 *  a different scope refuses WITHOUT deleting the pending record — a
 *  live-observed bare consumption otherwise burns the token into a
 *  `projectedFrom: null` approval no plan-scoped build gate accepts. */

export const APPROVAL_TOKEN_TTL_MS = 30 * 60 * 1000;

export type TokenVerdict = "ok" | "no-pending" | "mismatch" | "expired" | "stale-map" | "path-mismatch";

interface PendingApproval {
  schemaVersion: 2;
  tokenHash: string;
  approvalHash: string;
  /** Resolved absolute path of the projected plan html; null = bare map. */
  projectedFrom: string | null;
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
  opts?: { now?: () => Date; projectedFrom?: string | null },
): Promise<string> {
  const now = opts?.now ?? (() => new Date());
  const token = randomBytes(8).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "0").slice(0, 10);
  const pending: PendingApproval = {
    schemaVersion: 2,
    tokenHash: hashToken(token),
    approvalHash,
    projectedFrom: opts?.projectedFrom ?? null,
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
  opts?: { now?: () => Date; projectedFrom?: string | null },
): Promise<TokenVerdict> {
  const now = opts?.now ?? (() => new Date());
  const path = pendingApprovalPath(projectRoot);
  let pending: PendingApproval;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PendingApproval;
    if (parsed.schemaVersion !== 2 || typeof parsed.tokenHash !== "string") return "no-pending";
    pending = parsed;
  } catch {
    return "no-pending";
  }
  const supplied = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(pending.tokenHash, "hex");
  if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return "mismatch";
  // F6.0-6: path BEFORE map hash — a projected map can hash differently from
  // the bare map, and a wrongly-scoped consumption must name the actual
  // problem (the path), not a misleading "map changed". Refusal is
  // non-destructive: the token survives for a corrected retry.
  if (pending.projectedFrom !== (opts?.projectedFrom ?? null)) return "path-mismatch";
  if (pending.approvalHash !== approvalHash) return "stale-map";
  if (now().getTime() - Date.parse(pending.issuedAt) > APPROVAL_TOKEN_TTL_MS) return "expired";
  await rm(path, { force: true });
  return "ok";
}

/** The pending token's projection scope, for building a copy-pasteable retry
 *  hint on path-mismatch. null = no pending record, unreadable, or bare scope. */
export async function readPendingProjectedFrom(projectRoot: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(pendingApprovalPath(projectRoot), "utf8")) as PendingApproval;
    return parsed.schemaVersion === 2 && typeof parsed.projectedFrom === "string" ? parsed.projectedFrom : null;
  } catch {
    return null;
  }
}
