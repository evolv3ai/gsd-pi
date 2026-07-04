/**
 * GSD Skill Discovery
 *
 * Detects skills installed during auto-mode by comparing the current
 * installed catalog and skill directories against a snapshot taken at auto-mode start.
 *
 * New skills are surfaced via resource reload when possible, with a fallback
 * prompt block when reload fails before the next agent turn.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { getSkillDirectories } from "@gsd/pi-coding-agent";
import { gsdHome } from "./gsd-home.js";
import { getInstalledSkills, normalizeSkillName } from "./skills.js";

export interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
}

/**
 * Snapshot state. `searchDirs` is captured at snapshot time so every detection
 * pass during the session scans the same project + user dirs (the bug fix:
 * previously only user dirs were scanned, so skills installed into the project
 * mid-session were silently missed).
 */
interface SkillSnapshotState {
  baselineNames: Set<string>;
  searchDirs: string[];
}

let snapshot: SkillSnapshotState | null = null;

/**
 * Snapshot the current installed skill catalog. Call at auto-mode start.
 * `cwd` is the project base path; skills dropped into `<cwd>/.agents/skills/`,
 * `<cwd>/.claude/skills/`, or `<cwd>/.gsd/skills/` mid-session are detected.
 */
export function snapshotSkills(options?: { cwd?: string }): void {
  const searchDirs = getSkillDirectories({
    cwd: options?.cwd ?? process.cwd(),
    gsdHome: gsdHome(),
  }).map((entry) => entry.path);
  snapshot = {
    baselineNames: snapshotCurrentSkillNames(searchDirs),
    searchDirs,
  };
}

/**
 * Clear the snapshot. Call when auto-mode stops.
 */
export function clearSkillSnapshot(): void {
  snapshot = null;
}

/**
 * Check if a snapshot is active (auto-mode is running with discovery).
 */
export function hasSkillSnapshot(): boolean {
  return snapshot !== null;
}

/**
 * Detect skills installed since the snapshot was taken.
 * Returns skill metadata for any new skills found in the loader catalog or on disk.
 */
export function detectNewSkills(): DiscoveredSkill[] {
  if (!snapshot) return [];

  const newSkills: DiscoveredSkill[] = [];
  for (const skill of getCurrentSkillsForDiscovery(snapshot.searchDirs)) {
    const normalized = normalizeSkillName(skill.name);
    if (snapshot.baselineNames.has(normalized)) continue;
    newSkills.push(skill);
  }

  return newSkills;
}

/**
 * Reload the skill catalog when auto-mode detects newly installed skills.
 * Returns discovered skills even if reload fails so callers can surface them
 * in the prompt. Updates the snapshot baseline only after a successful reload
 * so detection is retried after failures.
 */
export async function refreshCatalogForNewSkills(options?: {
  reload?: () => Promise<void>;
  notify?: (message: string, level: "info" | "warning") => void;
}): Promise<DiscoveredSkill[]> {
  const newSkills = detectNewSkills();
  if (newSkills.length === 0) return [];

  if (options?.reload) {
    try {
      await options.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.notify?.(`GSD: failed to reload skill catalog: ${message}`, "warning");
      return newSkills;
    }
  }

  // Re-snapshot, preserving the search dirs captured at auto-mode start.
  if (snapshot) {
    snapshot = {
      baselineNames: snapshotCurrentSkillNames(),
      searchDirs: snapshot.searchDirs,
    };
  }
  const names = newSkills.map((skill) => skill.name).join(", ");
  options?.notify?.(`GSD: loaded new skills: ${names}`, "info");
  return newSkills;
}

export function appendDiscoveredSkillsFallback(systemPrompt: string, skills: DiscoveredSkill[]): string {
  const missingSkills = skills.filter(skill => !systemPrompt.includes(skill.location));
  if (missingSkills.length === 0) return systemPrompt;

  return `${systemPrompt}\n\n${formatDiscoveredSkillsXml(missingSkills)}`;
}

// ─── Internals ────────────────────────────────────────────────────────────────

function formatDiscoveredSkillsXml(skills: DiscoveredSkill[]): string {
  const lines = [
    "<newly_discovered_skills>",
    "  <note>These skills were detected after this session started and may be absent from &lt;available_skills&gt;. If relevant, read the skill file at its location before using it.</note>",
  ];

  for (const skill of skills) {
    lines.push(
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.location)}</location>`,
      "  </skill>",
    );
  }

  lines.push("</newly_discovered_skills>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case "\"": return "&quot;";
      default: return char;
    }
  });
}

function snapshotCurrentSkillNames(searchDirsOverride?: string[]): Set<string> {
  // Uses explicit dirs, the snapshot's search dirs when active, or user-only dirs
  // (no project context) when called before a snapshot is taken.
  const searchDirs = searchDirsOverride ?? snapshot?.searchDirs ?? defaultSearchDirs();
  return new Set(getCurrentSkillsForDiscovery(searchDirs).map(skill => normalizeSkillName(skill.name)));
}

function defaultSearchDirs(): string[] {
  return getSkillDirectories({ cwd: process.cwd(), gsdHome: gsdHome() }).map((entry) => entry.path);
}

function getCurrentSkillsForDiscovery(searchDirs: string[]): DiscoveredSkill[] {
  const skills = new Map<string, DiscoveredSkill>();
  for (const skill of getInstalledSkills()) {
    const normalized = normalizeSkillName(skill.name);
    skills.set(normalized, {
      name: skill.name,
      description: skill.description || `Skill: ${skill.name}`,
      location: skill.filePath,
    });
  }

  for (const skill of getDiskSkills(searchDirs)) {
    const normalized = normalizeSkillName(skill.name);
    if (!skills.has(normalized)) skills.set(normalized, skill);
  }

  return [...skills.values()];
}

function getDiskSkills(searchDirs: string[]): DiscoveredSkill[] {
  const skills = new Map<string, DiscoveredSkill>();
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillMdPath = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      const meta = parseSkillFrontmatter(skillMdPath);
      const name = meta?.name || entry.name;
      const normalized = normalizeSkillName(name);
      if (skills.has(normalized)) continue;
      skills.set(normalized, {
        name,
        description: meta?.description || `Skill: ${name}`,
        location: skillMdPath,
      });
    }
  }
  return [...skills.values()];
}

function parseSkillFrontmatter(path: string): { name?: string; description?: string } | null {
  try {
    const content = readFileSync(path, "utf-8");
    if (!content.startsWith("---\n")) return null;
    const endIdx = content.indexOf("\n---", 4);
    if (endIdx === -1) return null;

    const fm = content.slice(4, endIdx);
    const result: { name?: string; description?: string } = {};

    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    if (nameMatch) result.name = nameMatch[1].trim();

    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (descMatch) result.description = descMatch[1].trim();

    return result;
  } catch {
    return null;
  }
}
