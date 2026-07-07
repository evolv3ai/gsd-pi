import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { BucketRow, PresetsRecord, ProbeOutcome, ProductService } from "./types.js";

export const PRESETS_RELATIVE_PATH = join("specs", "PRESETS.md");

function bucketTable(buckets: BucketRow[]): string {
  const rows = buckets.map((b) => `| ${b.bucket} | ${b.model} | ${b.source} | ${b.status} |`);
  return ["| bucket | model | source | status |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function productTable(product: ProductService[]): string {
  if (product.length === 0) return "_none declared_";
  const rows = product.flatMap((s) =>
    s.envVars.map((v) => {
      const where = v.provenance === "env-file" ? `env-file(${v.file})` : v.provenance;
      const marks = [s.guessed ? "guessed" : null, s.injectionDisclaimer ? "may be tool-injected — not detectable" : null]
        .filter(Boolean).join("; ");
      return `| ${s.service} | ${v.name} | ${where} | ${marks} |`;
    }),
  );
  return ["| service | env var | found in | notes |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function probeTable(probes: ProbeOutcome[]): string {
  if (probes.length === 0) return "_no probes run_";
  const rows = probes.map((p) => `| ${p.target} | ${p.tier} | ${p.verdict} | ${p.detail}${p.cost ? ` (${p.cost})` : ""} | ${p.checkedAt} |`);
  return ["| target | tier | verdict | detail | checked |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function verificationCommandsSection(commands: string[]): string {
  if (commands.length === 0) return "_none approved_";
  return commands.map((c) => `- ${c}`).join("\n");
}

/** The body is fully generated — hand edits are overwritten on the next sign-off. */
function renderBody(record: PresetsRecord): string {
  const approval = record.approval;
  return [
    "",
    "# Workflow PRESETS",
    "",
    "Planned/approved intent for the planf3-gsd pipeline. GSD's `.gsd/PREFERENCES.md`",
    "remains the applied state; this file never overrides it (spec NFR-2).",
    "",
    "## Approval",
    "",
    approval
      ? `Approved ${approval.approvedAt} by ${approval.approvedBy ? `${approval.approvedBy.model} (${approval.approvedBy.authMode})` : "unknown"}${approval.note ? ` — note: ${approval.note}` : ""}; hash \`${approval.approvalHash}\` projected from ${approval.projectedFrom ?? "(bare — no plan)"}.`
      : "_not approved yet — run /planf3-gsd-preflight and sign off_",
    "",
    "## GSD build buckets (post-overlay projection)",
    "",
    "The `approvalHash` covers exactly the **bridge-owned** surface: this bucket map",
    "plus `verification_commands`. Hand-written PREFERENCES keys (dynamic_routing,",
    "tool_call_loop_guard, …) are validated but never hashed — a hash mismatch always",
    "means a bridge-owned key changed (spec §5.1).",
    "",
    bucketTable(record.stages.gsdBuild.buckets),
    "",
    "## Verification commands",
    "",
    "The approval hash covers exactly the commands below plus the bucket map",
    "above (spec §5.1 disk-recomputable surface).",
    "",
    verificationCommandsSection(record.stages.gsdBuild.verificationCommands ?? []),
    "",
    "## Product integrations",
    "",
    productTable(record.product),
    "",
    "## Probes",
    "",
    probeTable(record.probes),
    "",
  ].join("\n");
}

export function renderPresets(record: PresetsRecord): string {
  const fm = {
    schemaVersion: record.schemaVersion,
    approval: record.approval,
    history: record.history,
    stages: record.stages,
    product: record.product,
    probes: record.probes,
  };
  return `---\n${stringifyYaml(fm)}---\n${renderBody(record)}`;
}

export function parsePresets(text: string): PresetsRecord {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    throw new Error("specs/PRESETS.md has no YAML frontmatter; not a PRESETS file");
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("specs/PRESETS.md frontmatter is missing its closing --- delimiter; not modifying it");
  }
  const block = text.slice(4, end).replace(/\r/g, "");
  const parsed = parseYaml(block);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("specs/PRESETS.md frontmatter is not a YAML object; not modifying it");
  }
  const fm = parsed as Record<string, unknown>;
  return {
    schemaVersion: 1,
    approval: (fm.approval as PresetsRecord["approval"]) ?? null,
    history: (fm.history as PresetsRecord["history"]) ?? [],
    stages: fm.stages as PresetsRecord["stages"],
    product: (fm.product as PresetsRecord["product"]) ?? [],
    probes: (fm.probes as PresetsRecord["probes"]) ?? [],
  };
}

export async function readPresets(projectRoot: string): Promise<PresetsRecord | null> {
  let text: string;
  try {
    text = await readFile(join(projectRoot, PRESETS_RELATIVE_PATH), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parsePresets(text);
}

export async function writePresets(projectRoot: string, record: PresetsRecord): Promise<string> {
  const path = join(projectRoot, PRESETS_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderPresets(record), "utf8");
  return path;
}
