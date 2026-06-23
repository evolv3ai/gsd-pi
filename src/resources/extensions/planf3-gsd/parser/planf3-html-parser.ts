import { parse, type HTMLElement } from "node-html-parser";
import type { ParsedPlan, PlanMetadata, PlanFile, PlanPhase, PlanTask, PlanChecklistItem, PlanAmendment, PlanStatus } from "./types.ts";
import { STATUS_FROM_MARKER } from "./types.ts";

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

function sectionText(root: HTMLElement, id: string): string {
  const section = root.querySelector(`section#${id}`);
  if (!section) return "";
  const heading = section.querySelector("h2");
  if (heading) heading.remove();
  return section.text.replace(/\s+/g, " ").trim();
}

function parseFileGroup(root: HTMLElement, headingText: string, kind: PlanFile["kind"]): PlanFile[] {
  const section = root.querySelector("section#files");
  if (!section) return [];
  const headings = section.querySelectorAll("h3");
  const heading = headings.find((h) => h.text.trim().toLowerCase() === headingText.toLowerCase());
  if (!heading) return [];
  const list = heading.nextElementSibling;
  if (!list || list.tagName !== "UL") return [];
  return list.querySelectorAll("li").map((li) => {
    const code = li.querySelector("code");
    const path = code?.text.trim() ?? "";
    code?.remove();
    li.querySelector("span.tag")?.remove();
    const description = li.text.replace(/^\s*[—–-]\s*/, "").trim();
    return { kind, path, description };
  });
}

function statusFromCode(code: HTMLElement | null): PlanStatus {
  const marker = code?.text.trim() ?? "[]";
  return STATUS_FROM_MARKER[marker] ?? "todo";
}

function parseChecklist(ul: HTMLElement | undefined): PlanChecklistItem[] {
  if (!ul) return [];
  return ul.querySelectorAll("li").map((li) => {
    const code = li.querySelector("code.status");
    const status = statusFromCode(code);
    code?.remove();
    const text = li.text.replace(/\s+/g, " ").trim();
    return { status, text };
  });
}

function parsePhase(div: HTMLElement): PlanPhase {
  const h3 = div.querySelector("h3");
  const phaseStatus = statusFromCode(h3?.querySelector("code.status") ?? null);
  h3?.querySelector("code.status")?.remove();
  const title = (h3?.text ?? "").replace(/\s+/g, " ").trim();

  const description = div.querySelector("p")?.text.replace(/\s+/g, " ").trim() ?? "";

  const tasks: PlanTask[] = [];
  const headings = div.querySelectorAll("h4");
  for (const h4 of headings) {
    const taskTitle = h4.text.replace(/\s+/g, " ").trim();
    let sib = h4.nextElementSibling;
    let ul: HTMLElement | undefined;
    while (sib && sib.tagName !== "H4") {
      if (sib.tagName === "UL" && sib.classList.contains("checklist")) {
        ul = sib;
        break;
      }
      sib = sib.nextElementSibling;
    }
    tasks.push({ title: taskTitle, checklist: parseChecklist(ul) });
  }

  return { title, status: phaseStatus, description, tasks };
}

function parsePhases(root: HTMLElement): PlanPhase[] {
  return root.querySelectorAll("section#phases div.phase").map(parsePhase);
}

function parseValidationCommands(root: HTMLElement): string[] {
  const items = root.querySelectorAll("section#validation ul.checklist li");
  return items.map((li) => {
    li.querySelector("code.status")?.remove();
    return li.text.replace(/\s+/g, " ").trim();
  }).filter((s) => s.length > 0);
}

function parseAmendments(root: HTMLElement): PlanAmendment[] {
  return root.querySelectorAll("section#amendments details").map((det) => {
    const summary = det.querySelector("summary")?.text.trim() ?? "";
    const m = /^([0-9T:\-+.]+)\s+—\s+(.*)$/.exec(summary);
    const iso = m?.[1] ?? "";
    const summaryText = m?.[2] ?? summary;
    det.querySelector("summary")?.remove();
    return { iso, summary: summaryText, body: det.text.replace(/\s+/g, " ").trim() };
  });
}

function parseOpenDecisions(root: HTMLElement): string[] {
  return root.querySelectorAll("section#questionables details summary").map((s) =>
    s.text.replace(/\s+/g, " ").trim(),
  );
}

export function parsePlanf3Html(html: string): ParsedPlan {
  const root = parse(html);
  const title = root.querySelector("header h1")?.text.trim() ?? "";
  const tagline = root.querySelector("header p.tagline")?.text.trim() ?? null;
  return {
    title,
    tagline,
    metadata: parseMetadata(root),
    purpose: sectionText(root, "purpose"),
    problem: sectionText(root, "problem"),
    solution: sectionText(root, "solution"),
    existingFiles: parseFileGroup(root, "Existing Files", "existing"),
    newFiles: parseFileGroup(root, "New Files", "new"),
    phases: parsePhases(root),
    validationCommands: parseValidationCommands(root),
    notes: sectionText(root, "notes"),
    amendments: parseAmendments(root),
    openDecisions: parseOpenDecisions(root),
  };
}
