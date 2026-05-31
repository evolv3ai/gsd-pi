/**
 * Self-contained HTML chart for /gsd context --open
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContextBreakdownReport, ContextSectionBreakdown } from "./commands-context.js";
import { getContextChartTotals } from "./context-overlay.js";
import { formatTokenCount } from "./metrics.js";
import { gsdRoot } from "./paths.js";

const SYSTEM_COLORS = ["#5e6ad2", "#7c89ff", "#9aa5ff", "#b8c0ff", "#d4d9ff"];
const HISTORY_COLORS = ["#3ecf8e", "#56d89a", "#72e2ad", "#8eebc1", "#aaf4d4"];

function esc(value: string | number | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDonutSvg(systemTokens: number, conversationTokens: number, otherTokens: number, remaining: number): string {
  const total = Math.max(systemTokens + conversationTokens + otherTokens + remaining, 1);
  const radius = 54;
  const stroke = 16;
  const center = 70;
  const circumference = 2 * Math.PI * radius;

  const segments = [
    { value: systemTokens, color: "#5e6ad2", label: "System" },
    { value: conversationTokens, color: "#3ecf8e", label: "History" },
    { value: otherTokens, color: "#f59e0b", label: "Other" },
    { value: remaining, color: "#2b2e38", label: "Free" },
  ].filter((segment) => segment.value > 0);

  let offset = 0;
  const arcs = segments.map((segment) => {
    const length = (segment.value / total) * circumference;
    const dash = `${length} ${circumference - length}`;
    const rotate = (offset / total) * 360 - 90;
    offset += segment.value;
    return `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="${stroke}" stroke-dasharray="${dash}" transform="rotate(${rotate} ${center} ${center})"><title>${esc(segment.label)} — ${esc(formatTokenCount(segment.value))}</title></circle>`;
  }).join("\n");

  return `
    <svg viewBox="0 0 140 140" width="140" height="140" class="donut">
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#1e2028" stroke-width="${stroke}" />
      ${arcs}
    </svg>`;
}

function renderBarRows(
  sections: ContextSectionBreakdown[],
  total: number,
  colors: string[],
): string {
  if (sections.length === 0) {
    return `<div class="empty">None</div>`;
  }

  const max = Math.max(...sections.map((section) => section.tokens), 1);
  return sections.map((section, index) => {
    const width = Math.max(4, Math.round((section.tokens / max) * 100));
    const pct = total > 0 ? ((section.tokens / total) * 100).toFixed(1) : "0.0";
    const color = colors[index % colors.length]!;
    return `
      <div class="bar-row">
        <div class="bar-label" title="${esc(section.label)}">${esc(section.label)}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${width}%;background:${color}"></div>
        </div>
        <div class="bar-meta">${esc(formatTokenCount(section.tokens))}<span>${pct}%</span></div>
        ${section.detail ? `<div class="bar-detail">${esc(section.detail)}</div>` : ""}
      </div>`;
  }).join("");
}

function renderSkillChips(names: string[], loaded: Set<string>, tone: "available" | "loaded"): string {
  if (names.length === 0) return `<div class="empty">None</div>`;
  return `<div class="chips">${names.map((name) => {
    const isLoaded = loaded.has(name);
    const cls = tone === "loaded" || isLoaded ? "chip chip-loaded" : "chip";
    return `<span class="${cls}">${esc(name)}</span>`;
  }).join("")}</div>`;
}

export function buildContextChartHtml(report: ContextBreakdownReport): string {
  const totals = getContextChartTotals(report);
  const chartTotal = Math.max(totals.inContext, totals.estimated, 1);
  const otherTokens = Math.max(0, totals.inContext - totals.estimated);
  const loaded = new Set(report.skills.loaded);
  const generated = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GSD Context Breakdown</title>
<style>
:root{
  --bg:#0f1115;--panel:#16181d;--panel-2:#1e2028;--border:#2b2e38;
  --text:#ededef;--muted:#a1a1aa;--dim:#71717a;--accent:#5e6ad2;--success:#3ecf8e;
  --font:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:JetBrains Mono,ui-monospace,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font)}
.wrap{max-width:980px;margin:0 auto;padding:32px 24px 48px}
.hero{display:grid;grid-template-columns:160px 1fr;gap:24px;align-items:center;margin-bottom:28px}
.hero h1{margin:0 0 8px;font-size:28px;font-weight:650;letter-spacing:-.02em}
.meta{color:var(--muted);font-size:13px}
.stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.stat-label{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.stat-value{margin-top:4px;font-size:22px;font-weight:650;font-family:var(--mono)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:18px 18px 12px}
.panel h2{margin:0 0 14px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.bar-row{display:grid;grid-template-columns:150px 1fr 110px;gap:12px;align-items:center;margin-bottom:12px}
.bar-label{font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{height:10px;background:var(--panel-2);border-radius:999px;overflow:hidden}
.bar-fill{height:100%;border-radius:999px}
.bar-meta{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right;white-space:nowrap}
.bar-meta span{margin-left:8px;color:var(--dim)}
.bar-detail{grid-column:1/-1;margin:-4px 0 0 162px;color:var(--dim);font-size:12px}
.empty{color:var(--dim);font-size:13px;padding:8px 0}
.skills{margin-top:18px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;background:var(--panel-2);border:1px solid var(--border);font-size:12px;color:var(--muted)}
.chip-loaded{color:var(--text);border-color:rgba(62,207,142,.35);background:rgba(62,207,142,.08)}
.legend{display:flex;gap:16px;margin-top:10px;color:var(--dim);font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.footer{margin-top:24px;color:var(--dim);font-size:12px}
@media (max-width:860px){.hero,.grid{grid-template-columns:1fr}.stat-grid{grid-template-columns:1fr}.bar-row{grid-template-columns:1fr}.bar-meta{text-align:left}.bar-detail{margin-left:0}}
</style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div>${buildDonutSvg(totals.systemTokens, totals.conversationTokens, otherTokens, totals.remaining)}</div>
    <div>
      <h1>Context Breakdown</h1>
      <div class="meta">${report.modelLabel ? esc(report.modelLabel) : "No model"} · Generated ${esc(generated)}</div>
      <div class="legend">
        <span><i class="dot" style="background:#5e6ad2"></i>System ${esc(formatTokenCount(totals.systemTokens))}</span>
        <span><i class="dot" style="background:#3ecf8e"></i>History ${esc(formatTokenCount(totals.conversationTokens))}</span>
        ${otherTokens > 0 ? `<span><i class="dot" style="background:#f59e0b"></i>Other ${esc(formatTokenCount(otherTokens))}</span>` : ""}
        <span><i class="dot" style="background:#2b2e38;border:1px solid #3b3f4c"></i>Free ${esc(formatTokenCount(totals.remaining))}</span>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">In context</div><div class="stat-value">${esc(formatTokenCount(totals.inContext))}</div></div>
        <div class="stat"><div class="stat-label">Window</div><div class="stat-value">${totals.window != null ? esc(formatTokenCount(totals.window)) : "—"}</div></div>
        <div class="stat"><div class="stat-label">Subagents</div><div class="stat-value">${report.subagentSpawns}</div></div>
      </div>
    </div>
  </section>

  <section class="grid">
    <div class="panel">
      <h2>System prompt</h2>
      ${renderBarRows(report.systemSections, chartTotal, SYSTEM_COLORS)}
    </div>
    <div class="panel">
      <h2>Conversation history</h2>
      ${renderBarRows(report.conversationSections, chartTotal, HISTORY_COLORS)}
    </div>
  </section>

  <section class="panel skills">
    <h2>Skills</h2>
    <div class="meta" style="margin-bottom:10px">Available (${report.skills.available.length})</div>
    ${renderSkillChips(report.skills.available, loaded, "available")}
    ${report.skills.loaded.length > 0 ? `<div class="meta" style="margin:14px 0 10px">Loaded this session</div>${renderSkillChips(report.skills.loaded, loaded, "loaded")}` : ""}
    ${report.skills.prefer.length > 0 ? `<div class="meta" style="margin:14px 0 10px">Prefer</div>${renderSkillChips(report.skills.prefer, loaded, "loaded")}` : ""}
  </section>

  <div class="footer">Generated by /gsd context · Token estimates from content size; tool schema overhead may differ.</div>
</div>
</body>
</html>`;
}

export function writeContextChartHtml(basePath: string, report: ContextBreakdownReport): string {
  const reportsDir = join(gsdRoot(basePath), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(reportsDir, `context-${timestamp}.html`);
  writeFileSync(outPath, buildContextChartHtml(report), "utf-8");
  return outPath;
}
