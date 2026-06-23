import { parse, type HTMLElement } from "node-html-parser";
import type { ParsedPlan, PlanMetadata } from "./types.ts";

const EMPTY_METADATA: PlanMetadata = {
  created: null,
  modified: [],
  commits: [],
  agentName: null,
  sessionId: null,
  backRefs: [],
  forwardRefs: [],
};

function parseList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "—") return [];
  return trimmed.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && trimmed !== "—" ? trimmed : null;
}

function parseMetadata(root: HTMLElement): PlanMetadata {
  const meta = root.querySelector("header details.meta dl");
  if (!meta) return EMPTY_METADATA;
  const pairs = new Map<string, string>();
  const children = meta.childNodes.filter((n) => n.nodeType === 1) as HTMLElement[];
  for (let i = 0; i < children.length - 1; i++) {
    const dt = children[i];
    const dd = children[i + 1];
    if (dt.tagName === "DT" && dd.tagName === "DD") {
      pairs.set(dt.text.trim().toLowerCase(), dd.text);
      i++;
    }
  }
  return {
    created: textOrNull(pairs.get("created") ?? ""),
    modified: parseList(pairs.get("modified") ?? ""),
    commits: parseList(pairs.get("commits") ?? ""),
    agentName: textOrNull(pairs.get("agent name") ?? ""),
    sessionId: textOrNull(pairs.get("session id") ?? ""),
    backRefs: parseList(pairs.get("back refs") ?? ""),
    forwardRefs: parseList(pairs.get("forward refs") ?? ""),
  };
}

export function parsePlanf3Html(html: string): ParsedPlan {
  const root = parse(html);
  const title = root.querySelector("header h1")?.text.trim() ?? "";
  const tagline = root.querySelector("header p.tagline")?.text.trim() ?? null;
  return {
    title,
    tagline,
    metadata: parseMetadata(root),
    purpose: "",
    problem: "",
    solution: "",
    existingFiles: [],
    newFiles: [],
    phases: [],
    validationCommands: [],
    notes: "",
    amendments: [],
    openDecisions: [],
  };
}
