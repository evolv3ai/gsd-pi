/**
 * Deterministic PF3 stable IDs (M4): pure function of document order —
 * phases PF3-P1…, tasks PF3-P1-T1…. Same plan → same IDs (re-export
 * stability); no randomness, no timestamps. These are the correlation
 * anchors that replace LLM-minted-title matching (e2e F-6.3).
 */
export function pf3PhaseId(phaseIndex: number): string {
  return `PF3-P${phaseIndex + 1}`;
}

export function pf3TaskId(phaseIndex: number, taskIndex: number): string {
  return `PF3-P${phaseIndex + 1}-T${taskIndex + 1}`;
}

/**
 * Extract the PF3 tag carried in a GSD-minted title. Exactly one DISTINCT
 * tag is required (the same tag repeated counts once); anything else is
 * "no unique answer" and the caller falls to the next correlation rung.
 */
export function uniqueTag(title: string): { phase: number; task: number | null } | null {
  const seen = new Set<string>();
  let last: RegExpMatchArray | null = null;
  for (const m of title.matchAll(/PF3-P(\d+)(?:-T(\d+))?/g)) {
    seen.add(m[0]);
    last = m;
  }
  if (seen.size !== 1 || last === null) return null;
  return { phase: Number(last[1]), task: last[2] !== undefined ? Number(last[2]) : null };
}
