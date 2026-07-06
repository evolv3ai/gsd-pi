import { bareModelId } from "../../gsd/model-router.js";

export interface CatalogPort {
  /** Full model ids as "provider/rest" (rest may itself contain "/"). */
  ids(): string[];
}

export interface ModelIdIssue {
  id: string;
  where: string;
  reason: string;
}

/**
 * Tier-0 validation: every configured model id — bridge-owned buckets AND
 * hand-written dynamic_routing.tier_models — is checked against the catalog
 * (validation ≠ ownership, spec §5.1: a typo'd tier model silently no-ops at
 * runtime and would otherwise stay invisible until that tier dispatches).
 * Matching mirrors getEligibleModels (GSD/model-router.ts:325-334): exact,
 * then provider-prefix-stripped via bareModelId.
 */
export function validateModelIds(
  entries: { id: string; where: string }[],
  catalog: CatalogPort,
): ModelIdIssue[] {
  const ids = catalog.ids();
  if (ids.length === 0) return []; // catalog unavailable is not evidence of a typo
  const exact = new Set(ids);
  const bare = new Set(ids.map((id) => bareModelId(id)));
  const issues: ModelIdIssue[] = [];
  for (const entry of entries) {
    if (exact.has(entry.id)) continue;
    if (bare.has(bareModelId(entry.id))) continue;
    issues.push({
      id: entry.id,
      where: entry.where,
      reason: `model id not found in the model catalog (checked exact and provider-prefix-stripped forms)`,
    });
  }
  return issues;
}
