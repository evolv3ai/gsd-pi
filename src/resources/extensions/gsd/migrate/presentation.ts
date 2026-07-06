// gsd-pi - /gsd migrate presentation helpers.
// File Purpose: Pure formatting for migration previews and post-write review prompts.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gsdRoot } from "../paths.js";
import type { MigrationPreview } from "./writer.js";

export interface ReviewPromptInput {
  sourcePath: string;
  gsdPath: string;
  preview: MigrationPreview;
  templatePath?: string;
}

function formatRequirements(preview: MigrationPreview): string | null {
  if (preview.requirements.total === 0) return null;
  return `Requirements: ${preview.requirements.total} (${preview.requirements.validated} validated, ${preview.requirements.active} active, ${preview.requirements.deferred} deferred, ${preview.requirements.outOfScope} out of scope)`;
}

function formatLegacyInputs(preview: MigrationPreview): string | null {
  if (!preview.migrationInputs) return null;
  return `Legacy inputs: ${preview.migrationInputs.milestonePhaseDirs} milestone phase dir(s), ${preview.migrationInputs.decisions} decision file(s), ${preview.migrationInputs.seeds} seed file(s)`;
}

export function buildMigrationPreviewSummary(preview: MigrationPreview, targetRoot: string): string[] {
  const lines: string[] = [
    `Decisions: ${preview.decisions.total}`,
    `Milestones: ${preview.milestoneCount}`,
    `Slices: ${preview.totalSlices} (${preview.doneSlices} done — ${preview.sliceCompletionPct}%)`,
    `Tasks: ${preview.totalTasks} (${preview.doneTasks} done — ${preview.taskCompletionPct}%)`,
  ];

  const requirements = formatRequirements(preview);
  if (requirements) lines.push(requirements);

  const legacyInputs = formatLegacyInputs(preview);
  if (legacyInputs) lines.push(legacyInputs);

  const targetGsdPath = gsdRoot(targetRoot);
  if (existsSync(targetGsdPath)) {
    lines.push("");
    lines.push(`⚠ A .gsd directory already exists at ${targetGsdPath}.`);
    lines.push("It will be backed up, deleted, and rewritten fresh before DB import.");
  }

  return lines;
}

export function formatMigrationPreviewStats(preview: MigrationPreview): string {
  const lines = [
    `- Decisions: ${preview.decisions.total}`,
    `- Milestones: ${preview.milestoneCount}`,
    `- Slices: ${preview.totalSlices} (${preview.doneSlices} done — ${preview.sliceCompletionPct}%)`,
    `- Tasks: ${preview.totalTasks} (${preview.doneTasks} done — ${preview.taskCompletionPct}%)`,
  ];

  const requirements = formatRequirements(preview);
  if (requirements) lines.push(`- ${requirements}`);

  const legacyInputs = formatLegacyInputs(preview);
  if (legacyInputs) lines.push(`- ${legacyInputs}`);

  return lines.join("\n");
}

function defaultReviewTemplatePath(): string {
  const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
  return join(promptsDir, "review-migration.md");
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const templatePath = input.templatePath ?? defaultReviewTemplatePath();
  let content = readFileSync(templatePath, "utf-8");

  content = content.replaceAll("{{sourcePath}}", input.sourcePath);
  content = content.replaceAll("{{gsdPath}}", input.gsdPath);
  content = content.replaceAll("{{previewStats}}", formatMigrationPreviewStats(input.preview));

  return content.trim();
}
