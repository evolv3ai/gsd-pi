export interface ActiveRef { id: string; title: string; }
export interface ProgressCounts { done: number; total: number; }

export interface BridgeStatus {
  phase: string;
  activeMilestone: ActiveRef | null;
  activeSlice: ActiveRef | null;
  activeTask: ActiveRef | null;
  progress: { milestones: ProgressCounts; slices: ProgressCounts; tasks: ProgressCounts; } | null;
  cost: number;
  nextAction: string | null;
  blockers: unknown[];
  sessionId: string | null;
}

const EMPTY: BridgeStatus = {
  phase: "unknown",
  activeMilestone: null,
  activeSlice: null,
  activeTask: null,
  progress: null,
  cost: 0,
  nextAction: null,
  blockers: [],
  sessionId: null,
};

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function activeRef(value: unknown): ActiveRef | null {
  const o = obj(value);
  if (!o) return null;
  const id = typeof o.id === "string" ? o.id : null;
  const title = typeof o.title === "string" ? o.title : null;
  return id !== null && title !== null ? { id, title } : null;
}

function counts(value: unknown): ProgressCounts | null {
  const o = obj(value);
  if (!o) return null;
  const done = typeof o.done === "number" ? o.done : 0;
  const total = typeof o.total === "number" ? o.total : 0;
  return { done, total };
}

export function mapQuerySnapshot(json: unknown): BridgeStatus {
  const root = obj(json);
  if (!root) return { ...EMPTY };
  const state = obj(root.state) ?? {};
  const cost = obj(root.cost);
  const progress = obj(state.progress);
  const progressBlock = progress
    ? {
        milestones: counts(progress.milestones) ?? { done: 0, total: 0 },
        slices: counts(progress.slices) ?? { done: 0, total: 0 },
        tasks: counts(progress.tasks) ?? { done: 0, total: 0 },
      }
    : null;
  return {
    phase: typeof state.phase === "string" ? state.phase : "unknown",
    activeMilestone: activeRef(state.activeMilestone),
    activeSlice: activeRef(state.activeSlice),
    activeTask: activeRef(state.activeTask),
    progress: progressBlock,
    cost: typeof cost?.total === "number" ? (cost.total as number) : 0,
    nextAction: typeof state.nextAction === "string" ? (state.nextAction as string) : null,
    blockers: Array.isArray(state.blockers) ? (state.blockers as unknown[]) : [],
    sessionId: typeof root.sessionId === "string" ? (root.sessionId as string) : null,
  };
}
