/**
 * M4 correlation ladder: resolve GSD's active slice/task to plan units by the
 * FIRST rung that yields a UNIQUE answer.
 *
 *   1. persisted binding (manifest gsdSlice/gsdTask) — wins outright
 *   2. PF3 tag carried in the GSD-minted title (export-time stable IDs)
 *   3. M3 title rules (marker-map matchIndex: normalized equality, then
 *      unique substring; tasks try checklist-item text, then h4 headings)
 *   4. singleton ordinal — SLICE LEVEL ONLY (exactly 1 plan phase and the
 *      milestone reports exactly 1 slice). Deliberately no task-level
 *      ordinal: ordinal task guesses would paint wrong markers.
 *   5. unmatched — nothing painted, title listed in the summary.
 *
 * Rung 2/3/4 successes mint new bindings for the manifest — but only when a
 * mapping entry actually exists (legacy manifests without mapping never bind).
 */
import type { ParsedPlan } from "../parser/types.js";
import type { BridgeStatus } from "../gsd/status-mapper.js";
import { matchIndex } from "./marker-map.js";
import { pf3PhaseId, pf3TaskId, uniqueTag } from "../export/pf3-id.js";

export interface MappedTask { title: string; pf3Id: string; gsdTask: string | null }
export interface MappedPhase { title: string; pf3Id: string; gsdSlice: string | null; tasks: MappedTask[] }

export type TaskTarget =
  | { kind: "item"; itemIndex: number }
  | { kind: "phase"; phaseIndex: number };

export interface ResolvedActive {
  slicePhaseIndex: number | null;
  taskTarget: TaskTarget | null;
  unmatched: string[];
}

export interface CorrelationResult extends ResolvedActive {
  newSliceBinding: { phaseIndex: number; gsdSlice: string } | null;
  newTaskBinding: { phaseIndex: number; taskIndex: number; gsdTask: string } | null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Tolerant reader of manifest.mapping.phases; legacy entries get canonical pf3Ids. */
export function mappingViewOf(manifest: unknown): MappedPhase[] {
  const phases = obj(obj(manifest)?.mapping)?.phases;
  if (!Array.isArray(phases)) return [];
  return phases.map((p, i) => {
    const ph = obj(p);
    const rawTasks = Array.isArray(ph?.tasks) ? (ph!.tasks as unknown[]) : [];
    return {
      title: str(ph?.title) ?? "",
      pf3Id: str(ph?.pf3Id) ?? pf3PhaseId(i),
      gsdSlice: str(ph?.gsdSlice),
      tasks: rawTasks.map((t, j) => {
        const to = obj(t);
        return { title: str(to?.title) ?? "", pf3Id: str(to?.pf3Id) ?? pf3TaskId(i, j), gsdTask: str(to?.gsdTask) };
      }),
    };
  });
}

export function correlate(plan: ParsedPlan, mapping: MappedPhase[], status: BridgeStatus): CorrelationResult {
  const unmatched: string[] = [];
  const phaseCount = plan.phases.length;
  let slicePhaseIndex: number | null = null;
  let taskTarget: TaskTarget | null = null;
  let newSliceBinding: CorrelationResult["newSliceBinding"] = null;
  let newTaskBinding: CorrelationResult["newTaskBinding"] = null;

  const pf3ToPhase = new Map<string, number>();
  mapping.forEach((p, i) => { if (i < phaseCount) pf3ToPhase.set(p.pf3Id, i); });

  const slice = status.activeSlice;
  if (slice !== null) {
    const persisted = mapping.findIndex((p) => p.gsdSlice !== null && p.gsdSlice === slice.id);
    if (persisted !== -1 && persisted < phaseCount) {
      slicePhaseIndex = persisted; // rung 1: stored binding wins outright
    } else {
      const tag = uniqueTag(slice.title);
      const tagged = tag === null ? undefined : pf3ToPhase.get(pf3PhaseId(tag.phase - 1));
      if (tagged !== undefined) {
        slicePhaseIndex = tagged; // rung 2
      } else {
        const byTitle = matchIndex(slice.title, plan.phases.map((p) => p.title));
        if (byTitle !== null) {
          slicePhaseIndex = byTitle; // rung 3
        } else if (phaseCount === 1 && status.progress?.slices.total === 1) {
          slicePhaseIndex = 0; // rung 4: singleton ordinal
        } else {
          unmatched.push(slice.title); // rung 5
        }
      }
      if (slicePhaseIndex !== null && mapping[slicePhaseIndex] !== undefined
          && mapping[slicePhaseIndex].gsdSlice !== slice.id) {
        newSliceBinding = { phaseIndex: slicePhaseIndex, gsdSlice: slice.id };
      }
    }
  }

  const task = status.activeTask;
  if (task !== null) {
    let persisted: { phaseIndex: number; taskIndex: number } | null = null;
    outer: for (let i = 0; i < mapping.length && i < phaseCount; i++) {
      for (let j = 0; j < mapping[i].tasks.length; j++) {
        if (mapping[i].tasks[j].gsdTask !== null && mapping[i].tasks[j].gsdTask === task.id) {
          persisted = { phaseIndex: i, taskIndex: j };
          break outer;
        }
      }
    }
    if (persisted !== null) {
      taskTarget = { kind: "phase", phaseIndex: persisted.phaseIndex }; // rung 1
    } else {
      const tag = uniqueTag(task.title);
      if (tag !== null && tag.task !== null) {
        const pi = tag.phase - 1;
        const ti = tag.task - 1;
        if (pi >= 0 && pi < phaseCount && mapping[pi] !== undefined && ti >= 0 && ti < mapping[pi].tasks.length) {
          taskTarget = { kind: "phase", phaseIndex: pi }; // rung 2 (tasks carry no marker; paint the phase)
          if (mapping[pi].tasks[ti].gsdTask !== task.id) {
            newTaskBinding = { phaseIndex: pi, taskIndex: ti, gsdTask: task.id };
          }
        }
      }
      if (taskTarget === null) {
        // rung 3 = M3 rules 4a/4b, implementation unchanged (matchIndex)
        const items: string[] = [];
        plan.phases.forEach((ph) => ph.tasks.forEach((t) => t.checklist.forEach((it) => items.push(it.text))));
        const byItem = matchIndex(task.title, items);
        if (byItem !== null) {
          taskTarget = { kind: "item", itemIndex: byItem }; // 4a: paints the item; no manifest entry to bind
        } else {
          const headings: { phaseIndex: number; taskIndex: number; title: string }[] = [];
          plan.phases.forEach((ph, pi) => ph.tasks.forEach((t, ti) => headings.push({ phaseIndex: pi, taskIndex: ti, title: t.title })));
          const byHeading = matchIndex(task.title, headings.map((h) => h.title));
          if (byHeading !== null) {
            const h = headings[byHeading];
            taskTarget = { kind: "phase", phaseIndex: h.phaseIndex }; // 4b
            if (mapping[h.phaseIndex]?.tasks[h.taskIndex] !== undefined
                && mapping[h.phaseIndex].tasks[h.taskIndex].gsdTask !== task.id) {
              newTaskBinding = { phaseIndex: h.phaseIndex, taskIndex: h.taskIndex, gsdTask: task.id };
            }
          } else {
            unmatched.push(task.title); // rung 5 — deliberately no task ordinal
          }
        }
      }
    }
  }

  return { slicePhaseIndex, taskTarget, unmatched, newSliceBinding, newTaskBinding };
}
