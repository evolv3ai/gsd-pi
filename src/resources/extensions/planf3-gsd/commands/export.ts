import { readFile, writeFile } from "node:fs/promises";
import { dirname, basename, extname, join } from "node:path";
import { parsePlanf3Html } from "../parser/planf3-html-parser.js";
import { exportGsdSpec } from "../export/gsd-spec-exporter.js";
import { buildManifest } from "../export/manifest-exporter.js";

export interface ExportResult {
  specPath: string;
  manifestPath: string;
  phaseCount: number;
  taskCount: number;
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
  const html = await readFile(htmlPath, "utf8");
  const plan = parsePlanf3Html(html);

  const specPath = siblingPath(htmlPath, ".gsd.md");
  const manifestPath = siblingPath(htmlPath, ".manifest.json");

  const spec = exportGsdSpec(plan, {
    htmlPath,
    manifestPath,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  });
  const manifest = buildManifest(
    plan,
    { htmlPath, specPath, projectRoot: opts.projectRoot ?? "." },
    { userPrompt: opts.userPrompt ?? null, mode: opts.mode ?? "step" },
  );

  await writeFile(specPath, spec, "utf8");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const taskCount = plan.phases.reduce((acc, p) => acc + p.tasks.length, 0);
  return { specPath, manifestPath, phaseCount: plan.phases.length, taskCount };
}
