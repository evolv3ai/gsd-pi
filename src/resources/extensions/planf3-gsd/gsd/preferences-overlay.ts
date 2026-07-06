import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { GsdModelPhaseKey } from "../parser/types.js";

export interface OverlayInput {
  modelPolicy: Partial<Record<GsdModelPhaseKey, string>>;
  verificationCommands: string[];
  sourceHtmlPath: string;
}

export interface OverlayResult {
  content: string;
  /** Bucket keys whose model changed this run (name is historical). */
  appliedModels: string[];
  /** bucket → model id for exactly those buckets. */
  appliedModelMap: Record<string, string>;
  appliedCommands: string[];
  changed: boolean;
}

export interface SplitFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function splitPreferences(existing: string | null, sourceHtmlPath: string): SplitFile {
  if (existing === null) {
    return {
      frontmatter: { version: 1 },
      body: `\n# GSD Project Preferences\n\nManaged in part by planf3-gsd (source plan: ${sourceHtmlPath}). Hand-written sections are preserved.\n`,
    };
  }
  if (existing.startsWith("---\n") || existing.startsWith("---\r\n")) {
    const end = existing.indexOf("\n---", 4);
    if (end === -1) {
      throw new Error(".gsd/PREFERENCES.md frontmatter is missing its closing --- delimiter; not modifying it");
    }
    const block = existing.slice(4, end).replace(/\r/g, "");
    const closeLineEnd = existing.indexOf("\n", end + 1);
    const body = closeLineEnd === -1 ? "" : existing.slice(closeLineEnd + 1);
    const parsed = parseYaml(block);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(".gsd/PREFERENCES.md frontmatter is not a YAML object; not modifying it");
    }
    return { frontmatter: parsed as Record<string, unknown>, body };
  }
  // No frontmatter delimiters: keep the whole file as body, add a fresh frontmatter block.
  return { frontmatter: { version: 1 }, body: existing };
}

export function mergePreferences(existing: string | null, input: OverlayInput): OverlayResult {
  const { frontmatter, body } = splitPreferences(existing, input.sourceHtmlPath);

  const models: Record<string, unknown> =
    frontmatter.models && typeof frontmatter.models === "object" && !Array.isArray(frontmatter.models)
      ? { ...(frontmatter.models as Record<string, unknown>) }
      : {};
  const appliedModels: string[] = [];
  const appliedModelMap: Record<string, string> = {};
  for (const [bucket, model] of Object.entries(input.modelPolicy)) {
    if (typeof model === "string" && models[bucket] !== model) {
      models[bucket] = model;
      appliedModels.push(bucket);
      appliedModelMap[bucket] = model;
    }
  }

  const existingCommands = Array.isArray(frontmatter.verification_commands)
    ? (frontmatter.verification_commands as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const appliedCommands = [...new Set(input.verificationCommands)].filter((c) => !existingCommands.includes(c));
  const commands = [...existingCommands, ...appliedCommands];

  const fm: Record<string, unknown> = { ...frontmatter };
  if (fm.version === undefined) fm.version = 1;
  if (Object.keys(models).length > 0) fm.models = models;
  if (commands.length > 0) fm.verification_commands = commands;

  const changed = appliedModels.length > 0 || appliedCommands.length > 0;
  const content = `---\n${stringifyYaml(fm)}---\n${body}`;
  return { content, appliedModels, appliedModelMap, appliedCommands, changed };
}

export async function applyPreferencesOverlay(projectRoot: string, input: OverlayInput): Promise<OverlayResult> {
  const prefsPath = join(projectRoot, ".gsd", "PREFERENCES.md");
  let existing: string | null = null;
  try {
    existing = await readFile(prefsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const result = mergePreferences(existing, input);
  if (result.changed) {
    await mkdir(join(projectRoot, ".gsd"), { recursive: true });
    await writeFile(prefsPath, result.content, "utf8");
  }
  return result;
}
