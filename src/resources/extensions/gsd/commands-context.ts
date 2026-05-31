/**
 * GSD Command — /gsd context
 *
 * Breaks down what's consuming the current LLM context window:
 * system prompt sections, GSD injections, skills, subagents, and history.
 */

import type { ExtensionCommandContext, ContextUsage, SessionEntry, SessionMessageEntry } from "@gsd/pi-coding-agent";

import { formatPercent, formatTokenCount } from "./metrics.js";
import { countTokensSync, type TokenProvider } from "./token-counter.js";
import { writeContextChartHtml } from "./context-chart-html.js";
import { openInBrowser } from "./export.js";

export interface ContextSectionBreakdown {
  label: string;
  tokens: number;
  detail?: string;
}

export interface SkillContextInfo {
  available: string[];
  loaded: string[];
  prefer: string[];
  avoid: string[];
}

export interface ContextBreakdownReport {
  modelLabel: string | null;
  contextUsage: ContextUsage | undefined;
  systemSections: ContextSectionBreakdown[];
  conversationSections: ContextSectionBreakdown[];
  skills: SkillContextInfo;
  subagentSpawns: number;
}


function resolveProvider(provider: string | undefined): TokenProvider {
  const normalized = (provider ?? "unknown").toLowerCase();
  if (normalized === "anthropic" || normalized === "claude-code") return normalized as TokenProvider;
  if (normalized === "openai" || normalized === "google" || normalized === "mistral" || normalized === "bedrock") {
    return normalized;
  }
  return "unknown";
}

function countTextTokens(text: string, provider: TokenProvider): number {
  if (!text) return 0;
  return countTokensSync(text, provider);
}

function extractXmlBlock(text: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return "";
  const end = text.indexOf(close, start);
  if (end < 0) return text.slice(start);
  return text.slice(start, end + close.length);
}

function parseSkillNamesFromXml(xml: string): string[] {
  const names: string[] = [];
  const re = /<name>([^<]+)<\/name>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    names.push(match[1]!.trim());
  }
  return names;
}

function parseSkillPreferences(systemPrompt: string): { prefer: string[]; avoid: string[] } {
  const prefer: string[] = [];
  const avoid: string[] = [];
  const preferMatch = systemPrompt.match(/prefer_skills:\s*\[([^\]]*)\]/i);
  const avoidMatch = systemPrompt.match(/avoid_skills:\s*\[([^\]]*)\]/i);
  if (preferMatch?.[1]) {
    for (const item of preferMatch[1].split(",")) {
      const name = item.trim().replace(/^["']|["']$/g, "");
      if (name) prefer.push(name);
    }
  }
  if (avoidMatch?.[1]) {
    for (const item of avoidMatch[1].split(",")) {
      const name = item.trim().replace(/^["']|["']$/g, "");
      if (name) avoid.push(name);
    }
  }
  return { prefer, avoid };
}

function sliceBetween(text: string, startMarker: string, endMarkers: string[]): string {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  let end = text.length;
  for (const marker of endMarkers) {
    const idx = text.indexOf(marker, start + startMarker.length);
    if (idx >= 0) end = Math.min(end, idx);
  }
  return text.slice(start, end);
}

export function parseSystemPromptSections(systemPrompt: string, provider: TokenProvider): ContextSectionBreakdown[] {
  if (!systemPrompt.trim()) return [];

  const sections: ContextSectionBreakdown[] = [];
  const gsdMarker = "[SYSTEM CONTEXT — GSD]";
  const gsdIdx = systemPrompt.indexOf(gsdMarker);

  const piBase = gsdIdx >= 0 ? systemPrompt.slice(0, gsdIdx) : systemPrompt;
  if (piBase.trim()) {
    const availableSkillsXml = extractXmlBlock(piBase, "available_skills");
    const piWithoutSkills = availableSkillsXml
      ? piBase.replace(availableSkillsXml, "")
      : piBase;
    if (piWithoutSkills.trim()) {
      sections.push({
        label: "Pi base prompt",
        tokens: countTextTokens(piWithoutSkills, provider),
      });
    }
    if (availableSkillsXml) {
      const skillNames = parseSkillNamesFromXml(availableSkillsXml);
      sections.push({
        label: "Available skills catalog",
        tokens: countTextTokens(availableSkillsXml, provider),
        detail: skillNames.length > 0 ? `${skillNames.length} skills` : undefined,
      });
    }
  }

  if (gsdIdx < 0) return sections;

  const gsdTail = systemPrompt.slice(gsdIdx);
  const gsdCoreEndMarkers = [
    "\n\n[KNOWLEDGE —",
    "\n\n[PROJECT CODEBASE —",
    "[WORKTREE CONTEXT —",
    "\n\n## Subagent Model",
    "GSD Skill Preferences",
  ];
  const gsdCore = sliceBetween(gsdTail, gsdMarker, gsdCoreEndMarkers);
  if (gsdCore.trim()) {
    sections.push({
      label: "GSD system prompt",
      tokens: countTextTokens(gsdCore, provider),
    });
  }

  const prefsBlock = systemPrompt.includes("GSD Skill Preferences")
    ? sliceBetween(
        systemPrompt,
        "GSD Skill Preferences",
        ["\n\n[KNOWLEDGE —", "\n\n[PROJECT CODEBASE —", "[WORKTREE CONTEXT —", "\n\n## Subagent Model"],
      )
    : "";
  if (prefsBlock.trim()) {
    sections.push({
      label: "Skill preferences",
      tokens: countTextTokens(prefsBlock, provider),
    });
  }

  const knowledge = sliceBetween(systemPrompt, "[KNOWLEDGE —", ["\n\n[PROJECT CODEBASE —", "[WORKTREE CONTEXT —", "\n\n## Subagent Model"]);
  if (knowledge.trim()) {
    sections.push({
      label: "Knowledge rules",
      tokens: countTextTokens(knowledge, provider),
    });
  }

  const codebase = sliceBetween(systemPrompt, "[PROJECT CODEBASE —", ["[WORKTREE CONTEXT —", "\n\n## Subagent Model"]);
  if (codebase.trim()) {
    sections.push({
      label: "Codebase map",
      tokens: countTextTokens(codebase, provider),
      detail: codebase.includes("truncated") ? "truncated" : undefined,
    });
  }

  const worktree = sliceBetween(systemPrompt, "[WORKTREE CONTEXT —", ["\n\n## Subagent Model"]);
  if (worktree.trim()) {
    sections.push({
      label: "Worktree context",
      tokens: countTextTokens(worktree, provider),
    });
  }

  const subagent = sliceBetween(systemPrompt, "## Subagent Model", []);
  if (subagent.trim()) {
    sections.push({
      label: "Subagent model hint",
      tokens: countTextTokens(subagent, provider),
    });
  }

  const mcpToolCount = (systemPrompt.match(/mcp__[^_\s]+__/g) ?? []).length;
  if (mcpToolCount > 0) {
    sections.push({
      label: "MCP tool schemas",
      tokens: 0,
      detail: `${mcpToolCount} tool references in prompt`,
    });
  }

  return sections;
}

function messageToText(message: SessionMessageEntry["message"]): string {
  const role = message.role;

  if (role === "assistant") {
    const parts: string[] = [];
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const typed = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
        if (typed.type === "text" && typed.text) parts.push(typed.text);
        if (typed.type === "thinking" && typed.thinking) parts.push(typed.thinking);
        if (typed.type === "toolCall") {
          parts.push(typed.name ?? "tool");
          parts.push(JSON.stringify(typed.arguments ?? {}));
        }
      }
    }
    return parts.join("\n");
  }

  if (role === "custom") {
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
        .map((block) => (block as { text?: string }).text ?? "")
        .join("\n");
    }
    return "";
  }

  if (role === "bashExecution") {
    return `${String(message.command ?? "")}\n${String(message.output ?? "")}`;
  }

  if (role === "compactionSummary" || role === "branchSummary") {
    return String(message.summary ?? "");
  }

  if ("content" in message) {
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
        .map((block) => (block as { text?: string }).text ?? "")
        .join("\n");
    }
  }

  return "";
}

function customTypeLabel(customType: string): string {
  const labels: Record<string, string> = {
    "gsd-memory": "Memory injection",
    "gsd-guided-context": "Guided execute context",
    "gsd-forensics": "Forensics context",
    "gsd-run": "GSD dispatch prompt",
    "gsd-discuss": "GSD discuss prompt",
    "gsd-debug-start": "Debug session prompt",
    "gsd-debug-continue": "Debug continue prompt",
    "gsd-debug-diagnose": "Debug diagnose prompt",
    "gsd-quick-task": "Quick task prompt",
    "gsd-doctor-heal": "Doctor heal prompt",
  };
  if (labels[customType]) return labels[customType];
  if (customType.startsWith("gsd-")) return `GSD injection (${customType})`;
  return `Custom (${customType})`;
}

function extractSkillNameFromPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(/\/skills\/([^/]+)\/SKILL\.md$/i)
    ?? normalized.match(/\/([^/]+)\/SKILL\.md$/i);
  return match?.[1] ?? null;
}

export function analyzeSessionContext(
  entries: ReadonlyArray<SessionEntry> | null | undefined,
  provider: TokenProvider,
): {
  conversationSections: ContextSectionBreakdown[];
  skills: SkillContextInfo;
  subagentSpawns: number;
} {
  const buckets = new Map<string, { tokens: number; count: number; details: Set<string> }>();
  const loadedSkills = new Set<string>();
  let subagentSpawns = 0;

  const addBucket = (label: string, text: string, detail?: string) => {
    const tokens = countTextTokens(text, provider);
    if (tokens <= 0 && !detail) return;
    const existing = buckets.get(label) ?? { tokens: 0, count: 0, details: new Set<string>() };
    existing.tokens += tokens;
    existing.count += 1;
    if (detail) existing.details.add(detail);
    buckets.set(label, existing);
  };

  if (!entries) {
    return {
      conversationSections: [],
      skills: { available: [], loaded: [], prefer: [], avoid: [] },
      subagentSpawns: 0,
    };
  }

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    const role = msg.role;
    const text = messageToText(msg);

    if (role === "user") {
      addBucket("User messages", text);
      continue;
    }

    if (role === "custom") {
      const customType = String(msg.customType ?? "custom");
      addBucket(customTypeLabel(customType), text, customType);
      continue;
    }

    if (role === "toolResult") {
      addBucket("Tool results", text);
      continue;
    }

    if (role === "assistant") {
      addBucket("Assistant responses", text);
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const typed = block as { type?: string; name?: string; arguments?: Record<string, unknown> };
          if (typed.type !== "toolCall") continue;
          if (typed.name === "subagent") subagentSpawns += 1;
          if (typed.name === "read" && typed.arguments && typeof typed.arguments.path === "string") {
            const skillName = extractSkillNameFromPath(typed.arguments.path);
            if (skillName) loadedSkills.add(skillName);
          }
        }
      }
      continue;
    }

    if (role === "compactionSummary") {
      addBucket("Compaction summaries", text);
      continue;
    }

    if (role === "branchSummary") {
      addBucket("Branch summaries", text);
      continue;
    }

    if (role === "bashExecution") {
      addBucket("Bash output", text);
    }
  }

  const conversationSections = [...buckets.entries()]
    .map(([label, value]) => ({
      label,
      tokens: value.tokens,
      detail: value.details.size > 0
        ? `${value.count} message${value.count === 1 ? "" : "s"}`
        : value.count > 1
          ? `${value.count} messages`
          : undefined,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    conversationSections,
    skills: { available: [], loaded: [...loadedSkills].sort(), prefer: [], avoid: [] },
    subagentSpawns,
  };
}

export function buildContextBreakdown(options: {
  modelLabel: string | null;
  provider: TokenProvider;
  contextUsage: ContextUsage | undefined;
  systemPrompt: string;
  entries: ReadonlyArray<SessionEntry> | null | undefined;
}): ContextBreakdownReport {
  const systemSections = parseSystemPromptSections(options.systemPrompt, options.provider);
  const session = analyzeSessionContext(options.entries, options.provider);

  const availableSkillsXml = extractXmlBlock(options.systemPrompt, "available_skills");
  const available = parseSkillNamesFromXml(availableSkillsXml);
  const prefs = parseSkillPreferences(options.systemPrompt);

  return {
    modelLabel: options.modelLabel,
    contextUsage: options.contextUsage,
    systemSections,
    conversationSections: session.conversationSections,
    skills: {
      available: [...new Set(available)].sort(),
      loaded: session.skills.loaded,
      prefer: prefs.prefer,
      avoid: prefs.avoid,
    },
    subagentSpawns: session.subagentSpawns,
  };
}

function formatSectionLines(sections: ContextSectionBreakdown[], totalKnown: number | null): string[] {
  if (sections.length === 0) return ["  (none)"];
  return sections.map((section) => {
    const pct = totalKnown && totalKnown > 0
      ? ` (${formatPercent((section.tokens / totalKnown) * 100)}%)`
      : "";
    const detail = section.detail ? ` — ${section.detail}` : "";
    return `  ${section.label}: ${formatTokenCount(section.tokens)} tokens${pct}${detail}`;
  });
}

export function formatContextReport(report: ContextBreakdownReport): string {
  const lines: string[] = ["Context Breakdown", ""];

  if (report.modelLabel) lines.push(`Model: ${report.modelLabel}`);

  const usage = report.contextUsage;
  if (usage) {
    if (usage.tokens != null && usage.percent != null) {
      lines.push(`In context: ${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} (${formatPercent(usage.percent)}%)`);
    } else {
      lines.push(`Window: ${formatTokenCount(usage.contextWindow)} tokens (usage unknown until next model response)`);
    }
  }

  const estimatedTotal = [
    ...report.systemSections,
    ...report.conversationSections,
  ].reduce((sum, section) => sum + section.tokens, 0);

  lines.push("");
  lines.push("System prompt");
  lines.push(...formatSectionLines(report.systemSections, usage?.tokens ?? estimatedTotal));

  lines.push("");
  lines.push("Conversation history");
  lines.push(...formatSectionLines(report.conversationSections, usage?.tokens ?? estimatedTotal));

  lines.push("");
  lines.push("Skills");
  if (report.skills.available.length > 0) {
    lines.push(`  Available (${report.skills.available.length}): ${report.skills.available.slice(0, 12).join(", ")}${report.skills.available.length > 12 ? "…" : ""}`);
  } else {
    lines.push("  Available: none in prompt");
  }
  if (report.skills.loaded.length > 0) {
    lines.push(`  Loaded this session: ${report.skills.loaded.join(", ")}`);
  } else {
    lines.push("  Loaded this session: none");
  }
  if (report.skills.prefer.length > 0) {
    lines.push(`  Prefer: ${report.skills.prefer.join(", ")}`);
  }
  if (report.skills.avoid.length > 0) {
    lines.push(`  Avoid: ${report.skills.avoid.join(", ")}`);
  }

  lines.push("");
  lines.push("Agents");
  lines.push(`  Subagent spawns this session: ${report.subagentSpawns}`);

  if (estimatedTotal > 0 && (usage?.tokens == null || Math.abs(estimatedTotal - usage.tokens) > usage.tokens * 0.15)) {
    lines.push("");
    lines.push(`Estimated from content: ${formatTokenCount(estimatedTotal)} tokens`);
    lines.push("Note: tool schemas and provider overhead may not be fully reflected.");
  }

  return lines.join("\n");
}

export async function handleContext(args: string, ctx: ExtensionCommandContext, basePath = process.cwd()): Promise<void> {
  const model = ctx.model;
  const modelLabel = model ? `${model.provider}/${model.id}` : null;
  const provider = resolveProvider(model?.provider);
  const contextUsage = ctx.getContextUsage?.();
  const systemPrompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();

  const report = buildContextBreakdown({
    modelLabel,
    provider,
    contextUsage,
    systemPrompt,
    entries,
  });

  if (args.includes("--json")) {
    ctx.ui.notify(JSON.stringify(report, null, 2), "info");
    return;
  }

  if (args.includes("--open")) {
    const outPath = writeContextChartHtml(basePath, report);
    openInBrowser(outPath);
    ctx.ui.notify(`Context chart saved: ${outPath}`, "info");
    return;
  }

  if (args.includes("--text")) {
    ctx.ui.notify(formatContextReport(report), "info");
    return;
  }

  if (ctx.hasUI) {
    const { GSDContextOverlay } = await import("./context-overlay.js");
    const result = await ctx.ui.custom<boolean>(
      (tui, theme, _kb, done) => new GSDContextOverlay(tui, theme, report, () => done(true)),
      {
        overlay: true,
        overlayOptions: {
          width: "88%",
          minWidth: 72,
          maxHeight: "90%",
          anchor: "center",
        },
      },
    );
    if (result === undefined) {
      const { formatContextChartText } = await import("./context-overlay.js");
      ctx.ui.notify(formatContextChartText(report), "info");
    }
    return;
  }

  ctx.ui.notify(formatContextReport(report), "info");
}
