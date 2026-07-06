/**
 * /gsd migrate — one-shot migration from .planning to .gsd
 *
 * Thin UX orchestrator: resolves paths, runs the validate → parse → transform →
 * preview → write pipeline, and shows confirmation UI via showNextAction.
 * All business logic lives in the pipeline modules (S01–S03).
 *
 * After a successful write, offers a read-only review that audits the output
 * for gsd-pi standards compliance.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { gsdRoot } from "../paths.js";
import { showNextAction } from "../../shared/tui.js";
import {
  notifyMigrateNeedsInteractiveMenu,
  requiresInteractiveMenu,
} from "../command-feedback.js";
import { executeMigrationWrite, type MigrationExecutionResult } from "./execution.js";
import { createMigrationPlan } from "./plan.js";
import { buildMigrationPreviewSummary, buildReviewPrompt } from "./presentation.js";
import type { MigrationPreview } from "./writer.js";

function dispatchReview(
  pi: ExtensionAPI,
  sourcePath: string,
  gsdPath: string,
  preview: MigrationPreview,
): void {
  const prompt = buildReviewPrompt({ sourcePath, gsdPath, preview });

  pi.sendMessage(
    {
      customType: "gsd-migrate-review",
      content: prompt,
      display: false,
    },
    { triggerTurn: true },
  );
}

export async function handleMigrate(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const plan = await createMigrationPlan(args);
  const { sourcePath, targetRoot } = plan;

  if (plan.status === "missing-source") {
    ctx.ui.notify(
      `Directory not found: ${sourcePath}\n\n` +
      "Migration converts a .planning/ directory (from older GSD versions) into .gsd/ format.\n" +
      "If you are starting a new project, use /gsd:new-project instead.\n" +
      "If migrating, ensure the path contains a .planning/ directory.",
      "error",
    );
    return;
  }

  for (const warning of plan.warnings) {
    ctx.ui.notify(`⚠ ${warning.message} (${warning.file})`, "warning");
  }
  for (const fatal of plan.fatals) {
    ctx.ui.notify(`✖ ${fatal.message} (${fatal.file})`, "error");
  }

  if (plan.status === "invalid") {
    ctx.ui.notify(
      "Migration blocked — fix the fatal issues above before retrying.",
      "error",
    );
    return;
  }

  if (plan.status === "blocked") {
    ctx.ui.notify(plan.message, "error");
    return;
  }

  const { project, preview } = plan;

  // ── Build preview text ─────────────────────────────────────────────────────
  const lines = buildMigrationPreviewSummary(preview, targetRoot);

  // ── Confirmation via showNextAction ────────────────────────────────────────
  if (requiresInteractiveMenu(ctx, false)) {
    notifyMigrateNeedsInteractiveMenu(ctx, "migration confirmation needs an interactive menu");
    return;
  }

  const choice = await showNextAction(ctx, {
    title: "Migration preview",
    summary: lines,
    actions: [
      {
        id: "confirm",
        label: "Write .gsd directory",
        description: `Migrate ${preview.milestoneCount} milestone(s) to ${gsdRoot(targetRoot)}`,
        recommended: true,
      },
      {
        id: "cancel",
        label: "Cancel",
        description: "Exit without writing anything",
      },
    ],
    notYetMessage: "Run /gsd migrate again when ready.",
  });

  if (choice !== "confirm") {
    ctx.ui.notify("Migration cancelled — no files were written.", "info");
    return;
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  ctx.ui.notify("Writing .gsd directory and importing DB state…", "info");

  let execution: MigrationExecutionResult;
  try {
    execution = await executeMigrationWrite(sourcePath, targetRoot, project, preview);
  } catch (err) {
    ctx.ui.notify(
      `Migration failed and the previous .gsd state was restored: ${(err as Error).message}`,
      "error",
    );
    return;
  }

  const gsdPath = gsdRoot(targetRoot);
  const { written, imported } = execution;

  ctx.ui.notify(
    `✓ Migration complete — ${written.paths.length} file(s) written to .gsd/, ${imported.hierarchy.milestones}M/${imported.hierarchy.slices}S/${imported.hierarchy.tasks}T imported to the database, and ${execution.audit.importedArtifacts} audit artifact(s) recorded`,
    "info",
  );

  // ── Post-write review offer ────────────────────────────────────────────────
  const reviewChoice = await showNextAction(ctx, {
    title: "Migration written",
    summary: [
      `${written.paths.length} files written to .gsd/`,
      `${imported.hierarchy.milestones} milestone(s), ${imported.hierarchy.slices} slice(s), and ${imported.hierarchy.tasks} task(s) imported to gsd.db`,
      `Legacy source archived at ${execution.legacyArchive.archivePath}`,
      `Migration audit written at ${execution.audit.migrationPath}`,
      "",
      "The agent can now review the migrated output against gsd-pi standards —",
      "checking structure, content quality, deriveState() round-trip, and",
      "requirement statuses. The review is read-only by default.",
    ],
    actions: [
      {
        id: "review",
        label: "Review migration",
        description: "Agent audits the .gsd output and reports PASS/FAIL per category",
        recommended: true,
      },
      {
        id: "skip",
        label: "Skip review",
        description: "Trust the migration output as-is",
      },
    ],
    notYetMessage: "Run /gsd migrate again to re-migrate, or review .gsd manually.",
  });

  if (reviewChoice === "review") {
    dispatchReview(pi, sourcePath, gsdPath, preview);
  }
}
