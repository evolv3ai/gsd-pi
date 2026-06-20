import type { Phase } from "./types.js";

export type StateTransitionReasonCode =
  | "state"
  | "manual"
  | "recovery"
  | "dependency"
  | "policy"
  | "retry";

export interface StateTransitionEntry {
  from: Phase | "*";
  event: string;
  guard: string;
  to: Phase;
  onFail: Phase | "manual-attention" | "blocked" | "no-transition";
  reasonCode: StateTransitionReasonCode;
}

export const STATE_TRANSITION_MATRIX: readonly StateTransitionEntry[] = [
  {
    from: "needs-discussion",
    event: "context-ready",
    guard: "CONTEXT artifact exists or PRD/context express path produced context",
    to: "researching",
    onFail: "needs-discussion",
    reasonCode: "state",
  },
  {
    from: "researching",
    event: "research-ready",
    guard: "RESEARCH artifact exists or research is explicitly skipped",
    to: "planning",
    onFail: "researching",
    reasonCode: "state",
  },
  {
    from: "planning",
    event: "plan-ready",
    guard: "ROADMAP/PLAN artifacts exist and plan gate passes",
    to: "executing",
    onFail: "replanning-slice",
    reasonCode: "state",
  },
  {
    from: "executing",
    event: "task-dispatched",
    guard: "task inputs are ready and dependencies are closed",
    to: "executing",
    onFail: "blocked",
    reasonCode: "dependency",
  },
  {
    from: "executing",
    event: "slice-complete",
    guard: "all slice tasks are closed and verification gate passes",
    to: "summarizing",
    onFail: "validating-milestone",
    reasonCode: "state",
  },
  {
    from: "summarizing",
    event: "summary-ready",
    guard: "SUMMARY artifact exists for the completed work unit",
    to: "validating-milestone",
    onFail: "summarizing",
    reasonCode: "state",
  },
  {
    from: "validating-milestone",
    event: "validation-pass",
    guard: "validation verdict is terminal and not remediation-required",
    to: "completing-milestone",
    onFail: "blocked",
    reasonCode: "state",
  },
  {
    from: "blocked",
    event: "recovery-plan-ready",
    guard: "reassessment produced an executable next action",
    to: "executing",
    onFail: "blocked",
    reasonCode: "recovery",
  },
  {
    from: "replanning-slice",
    event: "replan-ready",
    guard: "replacement slice/task plan exists and plan gate passes",
    to: "executing",
    onFail: "blocked",
    reasonCode: "recovery",
  },
  {
    from: "completing-milestone",
    event: "closeout-complete",
    guard: "closeout gate passes and git transaction succeeds",
    to: "complete",
    onFail: "blocked",
    reasonCode: "state",
  },
  {
    from: "*",
    event: "manual-block",
    guard: "operator or hard gate requested manual attention",
    to: "blocked",
    onFail: "manual-attention",
    reasonCode: "manual",
  },
  {
    from: "*",
    event: "retryable-failure",
    guard: "retry budget remains for failure class",
    to: "executing",
    onFail: "blocked",
    reasonCode: "retry",
  },
] as const;

export interface MatrixValidationResult {
  ok: boolean;
  missingEvents: string[];
  duplicateKeys: string[];
}

export function findTransition(
  from: Phase,
  event: string,
): StateTransitionEntry | undefined {
  return STATE_TRANSITION_MATRIX.find((entry) =>
    (entry.from === from || entry.from === "*") && entry.event === event,
  );
}

/**
 * Edge-keyed legality check for the Phase Transition Invariant (ADR-030).
 * `advance()` derives the next Phase and asserts the (from → to) edge here.
 *
 * The matrix is an assertion, not a decision-maker — `deriveState` already
 * chose the Phase. A self-edge is trivially legal (no transition to assert). An
 * edge is legal when some matrix entry permits it, honoring the `*` wildcard
 * rows (e.g. any → blocked via manual-block, any → executing via
 * retryable-failure).
 *
 * Note: the matrix is currently a sparse hardening spec, not a complete
 * legal-edge graph, so `advance()` consumes this in advisory mode (telemetry
 * only). It must be expanded to cover every edge `deriveState` emits before
 * enforcement flips on.
 */
export function isLegalEdge(from: Phase, to: Phase): boolean {
  if (from === to) return true;
  return STATE_TRANSITION_MATRIX.some(
    (entry) => (entry.from === from || entry.from === "*") && entry.to === to,
  );
}

/**
 * Thrown when an illegal derived Phase edge survives reconciliation. Carries
 * both endpoints so Recovery Classification can report them. Recognized by
 * class in `classifyFailure` and mapped to the `illegal-transition` kind.
 */
export class IllegalPhaseTransitionError extends Error {
  // Explicit fields, not constructor parameter properties — strip-types
  // consumers (workspace-index subprocess, integration tests) reject the
  // parameter-property syntax with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
  readonly from: Phase;
  readonly to: Phase;

  constructor(from: Phase, to: Phase) {
    super(`Illegal phase transition ${from} -> ${to} survived reconciliation`);
    this.name = "IllegalPhaseTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function validateTransitionMatrix(requiredEvents: readonly string[]): MatrixValidationResult {
  const seen = new Set<string>();
  const duplicateKeys: string[] = [];

  for (const entry of STATE_TRANSITION_MATRIX) {
    const key = `${entry.from}:${entry.event}`;
    if (seen.has(key)) duplicateKeys.push(key);
    seen.add(key);
  }

  const availableEvents = new Set(STATE_TRANSITION_MATRIX.map((entry) => entry.event));
  const missingEvents = requiredEvents.filter((event) => !availableEvents.has(event));

  return {
    ok: missingEvents.length === 0 && duplicateKeys.length === 0,
    missingEvents,
    duplicateKeys,
  };
}
