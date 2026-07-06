import { readFile, writeFile } from "node:fs/promises";
import { dirname, basename, extname, join } from "node:path";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import { exportGsdSpec } from "../export/gsd-spec-exporter.js";
import { buildManifest } from "../export/manifest-exporter.js";
import { friendlyError } from "./error-message.js";
import type { GsdModelPhaseKey } from "../parser/types.js";

export interface ExportResult {
  specPath: string;
  manifestPath: string;
  phaseCount: number;
  taskCount: number;
  modelPolicy: Partial<Record<GsdModelPhaseKey, string>>;
  validationCommands: string[];
}

export interface ExportOptions {
  generatedAt?: string;
  mode?: "auto" | "step";
  userPrompt?: string | null;
  projectRoot?: string;
}

function siblingPath(htmlPath: string, suffix: string): string {
  const dir = dirname(htmlPath);
  const stem = basename(htmlPath, extname(htmlPath));
  return join(dir, `${stem}${suffix}`);
}

export async function runExport(htmlPath: string, opts: ExportOptions = {}): Promise<ExportResult> {
  let html: string;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  const plan = parsePlanf3Html(html);

  const projectRoot = opts.projectRoot ?? ".";

  // Stamp which signed-off configuration this export belongs to, when one exists.
  let presetsRef: { path: string; approvalHash: string | null } | null = null;
  try {
    const { readPresets, PRESETS_RELATIVE_PATH } = await import("../preflight/presets-file.js");
    const record = await readPresets(projectRoot);
    if (record !== null) {
      presetsRef = { path: PRESETS_RELATIVE_PATH, approvalHash: record.approval?.approvalHash ?? null };
    }
  } catch {
    presetsRef = null; // corrupt PRESETS never blocks an export; preflight/build report it
  }

  const specPath = siblingPath(htmlPath, ".gsd.md");
  const manifestPath = siblingPath(htmlPath, ".manifest.json");

  const spec = exportGsdSpec(plan, {
    htmlPath,
    manifestPath,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  });
  const manifest = buildManifest(
    plan,
    { htmlPath, specPath, projectRoot },
    { userPrompt: opts.userPrompt ?? null, mode: opts.mode ?? "step" },
    presetsRef,
  );

  await writeFile(specPath, spec, "utf8");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const taskCount = plan.phases.reduce((acc, p) => acc + p.tasks.length, 0);
  return {
    specPath,
    manifestPath,
    phaseCount: plan.phases.length,
    taskCount,
    modelPolicy: plan.modelPolicy,
    validationCommands: plan.validationCommands,
  };
}
