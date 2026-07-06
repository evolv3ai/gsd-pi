import type { DriftRow, StageMap, Verdict } from "./types.js";

/** The guaranteed machine-parseable LAST stdout line (spec §6.1) — exit codes
 *  are clobbered by the host in pi --print (src/cli.ts:778 process.exit(0)). */
export function verdictLine(verdict: Verdict): string {
  return `preflight: verdict=${verdict}`;
}

export function renderMap(map: StageMap, verdict: Verdict, drift: DriftRow[]): string {
  const lines: string[] = [];
  lines.push("# Preflight — workflow map", "");
  lines.push("## Orchestrator");
  lines.push(
    map.orchestrator
      ? `${map.orchestrator.host} · model ${map.orchestrator.model} · auth ${map.orchestrator.authMode} · skills: ${map.orchestrator.skills.join(", ") || "none reported"}`
      : "unknown — run via the preflight skill (or the tool with orchestratorFacts) to fill this stage",
  );
  lines.push("", "## Planning (planf3)");
  lines.push(
    `skill: ${map.planning.skillAvailable === null ? "unknown" : map.planning.skillAvailable ? "available" : "NOT FOUND"} · model: ${map.planning.inheritsModel ?? "inherits orchestrator (unknown)"}`,
  );
  lines.push("", "## Export (deterministic)");
  lines.push(`planf3-gsd generator ${map.exportStage.generatorVersion} — no model, no auth`);
  lines.push("", `## GSD build — ${map.gsdBuild.binary} ${map.gsdBuild.version ?? "(version unknown)"}`);
  lines.push("", "| bucket | model | source | status |", "| --- | --- | --- | --- |");
  for (const b of map.gsdBuild.buckets) lines.push(`| ${b.bucket} | ${b.model} | ${b.source} | ${b.status} |`);
  if (map.validationIssues.length > 0) {
    lines.push("", "### Model-id validation issues (tier 0)");
    for (const issue of map.validationIssues) lines.push(`- ⚠ ${issue}`);
  }
  lines.push("", "## Project");
  lines.push(`root ${map.project.root} · branch ${map.project.branch ?? "(not a git repo?)"}`);
  lines.push("", "## Product integrations");
  if (map.product.length === 0) lines.push("_none declared (no #integrations section, nothing guessed)_");
  else {
    lines.push("| service | env var | found in | notes |", "| --- | --- | --- | --- |");
    for (const s of map.product) {
      for (const v of s.envVars) {
        const where = v.provenance === "env-file" ? `env-file(${v.file})` : v.provenance;
        const notes = [s.guessed ? "guessed" : null, s.injectionDisclaimer ? "may be tool-injected — not detectable" : null].filter(Boolean).join("; ");
        lines.push(`| ${s.service} | ${v.name} | ${where} | ${notes} |`);
      }
    }
  }
  lines.push("", "## Probes");
  if (map.probes.length === 0) lines.push("_none run (offline?)_");
  else {
    lines.push("| target | tier | verdict | detail |", "| --- | --- | --- | --- |");
    for (const p of map.probes) lines.push(`| ${p.target} | ${p.tier} | ${p.verdict} | ${p.detail}${p.cost ? ` (${p.cost})` : ""} |`);
  }
  if (drift.length > 0) {
    lines.push("", "## Drift vs signed-off record");
    lines.push("| kind | field | approved | current |", "| --- | --- | --- | --- |");
    for (const d of drift) lines.push(`| ${d.kind}-drift | ${d.field} | ${d.approved} | ${d.current} |`);
  }
  lines.push("", verdictLine(verdict));
  return lines.join("\n") + "\n";
}
