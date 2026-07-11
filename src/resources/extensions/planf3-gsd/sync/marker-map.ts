/**
 * Pure marker-sync computation: given a parsed plan, a GSD query snapshot,
 * and the manifest's milestone id, decide which status markers move.
 *
 * Occurrence convention (shared with html-rewrite.ts): the parser reads
 * <code class="status"> elements in document order, so markers enumerate as
 * — for each phase: the phase <h3> marker, then every checklist item of every
 * task in order — followed by the validation-section checklist markers.
 * html-rewrite.ts re-derives the count from the raw text and aborts on any
 * disagreement, so a template deviation can never cause a misplaced write.
 *
 * Markers only move forward (todo < wip < failed < done): re-running sync is
 * a no-op, hand-set [x] survives a [wip] snapshot, and a previously-[f] unit
 * is upgraded to [x] by milestone completion (completion means the retry
 * succeeded).
 */
import type { ParsedPlan, PlanStatus } from "../parser/types.js";
import { STATUS_TO_MARKER } from "../parser/types.js";
import type { BridgeStatus } from "../gsd/status-mapper.js";

export const RANK: Record<PlanStatus, number> = { todo: 0, wip: 1, failed: 2, done: 3 };

export interface MarkerUpdate {
  /** Zero-based index into the document-order <code class="status"> occurrences. */
  occurrence: number;
  /** Exact current token ("[]", "[wip]", …) — or null for validation markers,
   *  whose current status the parser does not expose; the rewriter then
   *  applies the monotonic rule against the token it finds on disk. */
  from: string | null;
  to: string;
  /** Human-readable owner (phase title / item text) for summaries. */
  label: string;
}

export interface SyncPlanResult {
  /** False when the snapshot shows this milestone neither active nor last-completed. */
  observable: boolean;
  /** True when rule 1 (completion sweep) fired. */
  completed: boolean;
  updates: MarkerUpdate[];
  /** Titles of active refs that could not be uniquely located in the plan. */
  unmatched: string[];
  /** Total <code class="status"> occurrences the raw document must contain. */
  expectedMarkerCount: number;
}

interface Site {
  occurrence: number;
  kind: "phase" | "item" | "validation";
  phaseIndex: number; // -1 for validation
  status: PlanStatus | null; // null for validation (parser drops it)
  label: string;
}

function enumerateSites(plan: ParsedPlan): Site[] {
  const sites: Site[] = [];
  let n = 0;
  plan.phases.forEach((phase, pi) => {
    sites.push({ occurrence: n++, kind: "phase", phaseIndex: pi, status: phase.status, label: phase.title });
    for (const task of phase.tasks) {
      for (const item of task.checklist) {
        sites.push({ occurrence: n++, kind: "item", phaseIndex: pi, status: item.status, label: item.text });
      }
    }
  });
  for (const cmd of plan.validationCommands) {
    sites.push({ occurrence: n++, kind: "validation", phaseIndex: -1, status: null, label: cmd });
  }
  return sites;
}

export function normalizeTitle(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/^\s*phase\s+\d+\s*[:.\-]\s*/, "");
  s = s.replace(/^\s*\d+\s*[.:)]\s*/, "");
  s = s.replace(/[^a-z0-9\s]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Unique match: exact normalized equality first, else unique substring containment (either direction). */
export function matchIndex(needle: string, haystack: string[]): number | null {
  const n = normalizeTitle(needle);
  if (n.length === 0) return null;
  const norms = haystack.map(normalizeTitle);
  const exact: number[] = [];
  norms.forEach((h, i) => { if (h === n) exact.push(i); });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const contains: number[] = [];
  norms.forEach((h, i) => { if (h.length > 0 && (h.includes(n) || n.includes(h))) contains.push(i); });
  return contains.length === 1 ? contains[0] : null;
}

export function computeSync(plan: ParsedPlan, status: BridgeStatus, milestoneId: string): SyncPlanResult {
  const sites = enumerateSites(plan);
  const expectedMarkerCount = sites.length;
  const completed = status.lastCompletedMilestone?.id === milestoneId;
  const active = status.activeMilestone?.id === milestoneId;

  const pending = new Map<number, { update: MarkerUpdate; toRank: number }>();
  const raise = (site: Site, to: PlanStatus): void => {
    if (site.status !== null && RANK[to] <= RANK[site.status]) return; // monotonic: only upward
    const prev = pending.get(site.occurrence);
    if (prev !== undefined && prev.toRank >= RANK[to]) return;
    pending.set(site.occurrence, {
      toRank: RANK[to],
      update: {
        occurrence: site.occurrence,
        from: site.status === null ? null : STATUS_TO_MARKER[site.status],
        to: STATUS_TO_MARKER[to],
        label: site.label,
      },
    });
  };
  const collect = (): MarkerUpdate[] =>
    [...pending.values()].map((p) => p.update).sort((a, b) => a.occurrence - b.occurrence);

  if (completed) {
    // Rule 1: completion sweep — every marker in the document goes to done.
    for (const site of sites) raise(site, "done");
    return { observable: true, completed: true, updates: collect(), unmatched: [], expectedMarkerCount };
  }

  if (!active) {
    // Rule 2 gate: never paint this plan's markers from a foreign milestone's activity.
    return { observable: false, completed: false, updates: [], unmatched: [], expectedMarkerCount };
  }

  const unmatched: string[] = [];
  const activeStatus: PlanStatus = status.blockers.length > 0 ? "failed" : "wip";
  const phaseSites = sites.filter((s) => s.kind === "phase");

  if (status.activeSlice !== null) {
    // Rule 3: slice title vs phase headings.
    const i = matchIndex(status.activeSlice.title, phaseSites.map((s) => s.label));
    if (i === null) unmatched.push(status.activeSlice.title);
    else raise(phaseSites[i], activeStatus);
  }

  if (status.activeTask !== null) {
    // Rule 4a: task title vs checklist-item text.
    const itemSites = sites.filter((s) => s.kind === "item");
    const i = matchIndex(status.activeTask.title, itemSites.map((s) => s.label));
    if (i !== null) {
      raise(itemSites[i], activeStatus);
    } else {
      // Rule 4b: vs <h4> task headings — tasks carry no marker of their own,
      // so a heading match paints the containing phase's <h3>.
      const taskTitles: { title: string; phaseIndex: number }[] = [];
      plan.phases.forEach((phase, pi) => {
        for (const t of phase.tasks) taskTitles.push({ title: t.title, phaseIndex: pi });
      });
      const j = matchIndex(status.activeTask.title, taskTitles.map((t) => t.title));
      if (j === null) unmatched.push(status.activeTask.title);
      else raise(phaseSites[taskTitles[j].phaseIndex], activeStatus);
    }
  }

  return { observable: true, completed: false, updates: collect(), unmatched, expectedMarkerCount };
}
