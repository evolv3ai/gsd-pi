import { mergePreferences, splitPreferences } from "../gsd/preferences-overlay.js";
import type { ProjectionResult } from "./types.js";

function modelsOf(frontmatter: Record<string, unknown>): Record<string, string> {
  const raw = frontmatter.models;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function commandsOf(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.verification_commands;
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
}

function tierModelsOf(frontmatter: Record<string, unknown>, into: { id: string; where: string }[]): void {
  const dr = frontmatter.dynamic_routing;
  if (!dr || typeof dr !== "object" || Array.isArray(dr)) return;
  const tm = (dr as Record<string, unknown>).tier_models;
  if (!tm || typeof tm !== "object" || Array.isArray(tm)) return;
  for (const [tier, model] of Object.entries(tm as Record<string, unknown>)) {
    if (typeof model === "string") into.push({ id: model, where: `dynamic_routing.tier_models.${tier}` });
  }
}

export interface ProjectionInput {
  globalContent: string | null;
  projectContent: string | null;
  modelPolicy: Record<string, string>;
  validationCommands: string[];
  sourceHtmlPath: string;
}

/**
 * What .gsd/PREFERENCES.md resolution will look like AFTER this plan's policy
 * applies (spec §5.2): plan policy is merged into the PROJECT file the same way
 * runBuild's applyPreferencesOverlay does (mergePreferences is pure), then the
 * global/project layers combine the way gsd does (per-key override for models,
 * dedup-union for verification_commands — GSD/preferences.ts:860).
 */
export function projectPreferences(input: ProjectionInput): ProjectionResult {
  const projected = mergePreferences(input.projectContent, {
    modelPolicy: input.modelPolicy,
    verificationCommands: input.validationCommands,
    sourceHtmlPath: input.sourceHtmlPath,
  });
  const projectFm = splitPreferences(projected.content, input.sourceHtmlPath).frontmatter;
  const globalFm = input.globalContent === null
    ? {}
    : splitPreferences(input.globalContent, input.sourceHtmlPath).frontmatter;

  const globalModels = modelsOf(globalFm);
  const projectModels = modelsOf(projectFm);
  const rawProjectModels = modelsOf(
    input.projectContent === null ? {} : splitPreferences(input.projectContent, input.sourceHtmlPath).frontmatter,
  );

  const buckets: Record<string, string> = { ...globalModels, ...projectModels };
  const sources: ProjectionResult["sources"] = {};
  for (const bucket of Object.keys(buckets)) {
    if (input.modelPolicy[bucket] !== undefined && projectModels[bucket] === input.modelPolicy[bucket] && rawProjectModels[bucket] !== input.modelPolicy[bucket]) {
      sources[bucket] = "plan";
    } else if (projectModels[bucket] !== undefined) {
      sources[bucket] = "project";
    } else {
      sources[bucket] = "global";
    }
  }

  const verificationCommands = [...new Set([...commandsOf(globalFm), ...commandsOf(projectFm)])];

  const allModelIds: { id: string; where: string }[] = Object.entries(buckets)
    .map(([bucket, id]) => ({ id, where: `buckets.${bucket}` }));
  tierModelsOf(globalFm, allModelIds);
  tierModelsOf(projectFm, allModelIds);

  return { buckets, verificationCommands, sources, allModelIds };
}
