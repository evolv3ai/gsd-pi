/**
 * Canonical skill access for GSD extension code.
 *
 * Prefer {@link getInstalledSkills} (ResourceLoader / getLoadedSkills cache)
 * over ad-hoc directory scans.
 */

import { getLoadedSkills, type Skill } from "@gsd/pi-coding-agent";
import { resolveSkillReference, type SkillResolution } from "./preferences-skills.js";

/** Normalize a skill reference the same way preference matching does. */
export function normalizeSkillName(ref: string): string {
  return ref.trim().toLowerCase();
}

/** Installed skills from the pi loader cache, or an explicit override (tests). */
export function getInstalledSkills(override?: Skill[]): Skill[] {
  if (override) return override;
  return typeof getLoadedSkills === "function" ? getLoadedSkills() : [];
}

/** Skill names from the installed catalog. */
export function getInstalledSkillNames(skills?: Skill[]): string[] {
  return getInstalledSkills(skills).map((skill) => skill.name);
}

/** Snapshot normalized skill names for auto-mode diffing. */
export function snapshotInstalledSkillNames(skills?: Skill[]): Set<string> {
  return new Set(getInstalledSkillNames(skills).map(normalizeSkillName));
}

/** Names present now but absent from `baseline`. */
export function detectNewlyInstalledSkills(baseline: Set<string>, skills?: Skill[]): string[] {
  const current = snapshotInstalledSkillNames(skills);
  return [...current].filter((name) => !baseline.has(name));
}

export type InstalledSkillResolution = SkillResolution & { skill?: Skill };

/**
 * Resolve a preference skill reference to a path, validating against the
 * installed catalog when loader data is available.
 */
export function resolveInstalledSkill(
  ref: string,
  cwd: string,
  skills?: Skill[],
): InstalledSkillResolution {
  const resolution = resolveSkillReference(ref, cwd);
  const installed = getInstalledSkills(skills);
  if (installed.length === 0) {
    return resolution;
  }

  const byName = new Map(installed.map((skill) => [normalizeSkillName(skill.name), skill]));
  const normalizedRef = normalizeSkillName(ref);
  const byRef = byName.get(normalizedRef);
  if (byRef) {
    return {
      ...resolution,
      resolvedPath: byRef.filePath,
      method: resolution.method === "unresolved" ? "user-skill" : resolution.method,
      skill: byRef,
    };
  }

  if (resolution.resolvedPath) {
    const match = installed.find((skill) => skill.filePath === resolution.resolvedPath);
    if (match) {
      return { ...resolution, skill: match };
    }
  }

  return resolution;
}
