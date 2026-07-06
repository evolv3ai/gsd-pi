import { createHash } from "node:crypto";
import type { ProjectionResult } from "./types.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The approvalHash covers exactly what the build-time hook can recompute from
 * disk alone: the post-overlay bucket map and verification_commands (spec §5.1).
 * Orchestrator identity lives in approvedBy; the provider set is derivable.
 */
export function projectionHash(p: ProjectionResult): string {
  const enforceable = { buckets: p.buckets, verificationCommands: p.verificationCommands };
  return createHash("sha256").update(canonicalJson(enforceable)).digest("hex");
}
