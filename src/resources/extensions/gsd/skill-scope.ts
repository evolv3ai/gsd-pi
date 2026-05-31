/**
 * Per-unit skill catalog scoping for GSD auto and workflow dispatch.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";

import { resolveSkillManifest } from "./skill-manifest.js";
import { normalizeSkillName } from "./skills.js";
import { resolveManifest } from "./unit-context-manifest.js";

/**
 * Resolve which skill names should appear in `<available_skills>` for a unit.
 * Returns `undefined` for full catalog, `[]` for suppressed catalog, or a
 * name list for allowlist mode.
 */
export function resolveVisibleSkillNames(unitType: string | undefined): string[] | undefined {
  if (!unitType) return undefined;

  const unitManifest = resolveManifest(unitType);
  if (unitManifest) {
    switch (unitManifest.skills.mode) {
      case "none":
        return [];
      case "all":
        return undefined;
      case "allowlist":
        return [...unitManifest.skills.skills];
    }
  }

  const legacyAllowlist = resolveSkillManifest(unitType);
  return legacyAllowlist ?? undefined;
}

/** Whether this unit narrows or suppresses the skill catalog (not mode "all"). */
export function unitHasSkillManifest(unitType: string | undefined): boolean {
  if (!unitType) return false;
  const unitManifest = resolveManifest(unitType);
  if (unitManifest) {
    return unitManifest.skills.mode !== "all";
  }
  return resolveSkillManifest(unitType) !== null;
}

/** Apply unit manifest skill policy via setVisibleSkills. */
export function applyUnitSkillVisibility(
  pi: Pick<ExtensionAPI, "setVisibleSkills">,
  unitType: string | undefined,
): void {
  pi.setVisibleSkills(resolveVisibleSkillNames(unitType));
}

/** Installed skill names visible for a unit per manifest policy. */
export function effectiveSkillNamesForUnit(
  unitType: string | undefined,
  installed: string[],
): string[] {
  const visible = resolveVisibleSkillNames(unitType);
  if (visible === undefined) return installed;
  if (visible.length === 0) return [];
  const allowed = new Set(visible.map(normalizeSkillName));
  return installed.filter((name) => allowed.has(normalizeSkillName(name)));
}
