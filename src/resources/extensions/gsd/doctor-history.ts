import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { saveFile } from "./files.js";
import { gsdRoot } from "./paths.js";

import type { DoctorReport } from "./doctor-types.js";

export interface DoctorHistoryEntry {
  ts: string;
  ok: boolean;
  errors: number;
  warnings: number;
  fixes: number;
  codes: string[];
  /** Issue messages with severity and scope (added in Phase 2). */
  issues?: Array<{ severity: string; code: string; message: string; unitId: string }>;
  /** Fix descriptions applied during this run (added in Phase 2). */
  fixDescriptions?: string[];
  /** Milestone/slice scope this doctor run was scoped to (e.g. "M001/S02"). */
  scope?: string;
  /** Human-readable one-line summary of this doctor run. */
  summary?: string;
}

function buildDoctorHistorySummary(report: DoctorReport, errorCount: number, warningCount: number, issueDetails: DoctorHistoryEntry["issues"]): string {
  const summaryParts: string[] = [];
  if (report.ok) {
    summaryParts.push("Clean");
  } else {
    const counts: string[] = [];
    if (errorCount > 0) counts.push(`${errorCount} error${errorCount > 1 ? "s" : ""}`);
    if (warningCount > 0) counts.push(`${warningCount} warning${warningCount > 1 ? "s" : ""}`);
    summaryParts.push(counts.join(", "));
  }
  if (report.fixesApplied.length > 0) {
    summaryParts.push(`${report.fixesApplied.length} fixed`);
  }
  if (issueDetails && issueDetails.length > 0) {
    const topIssue = issueDetails.find(i => i.severity === "error") ?? issueDetails[0]!;
    summaryParts.push(topIssue.message);
  }
  return summaryParts.join(" · ");
}

export async function appendDoctorHistory(basePath: string, report: DoctorReport): Promise<void> {
  try {
    const historyPath = join(gsdRoot(basePath), "doctor-history.jsonl");
    const errorCount = report.issues.filter(i => i.severity === "error").length;
    const warningCount = report.issues.filter(i => i.severity === "warning").length;
    const issueDetails = report.issues
      .filter(i => i.severity === "error" || i.severity === "warning")
      .slice(0, 10) // cap to keep JSONL lines bounded
      .map(i => ({ severity: i.severity, code: i.code, message: i.message, unitId: i.unitId }));

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      ok: report.ok,
      errors: errorCount,
      warnings: warningCount,
      fixes: report.fixesApplied.length,
      codes: [...new Set(report.issues.map(i => i.code))],
      issues: issueDetails.length > 0 ? issueDetails : undefined,
      fixDescriptions: report.fixesApplied.length > 0 ? report.fixesApplied : undefined,
      scope: (report as { scope?: string }).scope,
      summary: buildDoctorHistorySummary(report, errorCount, warningCount, issueDetails),
    } satisfies DoctorHistoryEntry);
    const existing = existsSync(historyPath) ? readFileSync(historyPath, "utf-8") : "";
    await saveFile(historyPath, existing + entry + "\n");
  } catch { /* non-fatal */ }
}

/** Read the last N doctor history entries. Returns most-recent-first. */
export async function readDoctorHistory(basePath: string, lastN = 50): Promise<DoctorHistoryEntry[]> {
  try {
    const historyPath = join(gsdRoot(basePath), "doctor-history.jsonl");
    if (!existsSync(historyPath)) return [];
    const lines = readFileSync(historyPath, "utf-8").split("\n").filter(l => l.trim());
    return lines.slice(-lastN).reverse().map(l => JSON.parse(l) as DoctorHistoryEntry);
  } catch { return []; }
}
