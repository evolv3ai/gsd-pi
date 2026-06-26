// Project/App: gsd-pi
// File Purpose: Classify a parsed .planning/ tree into its layout so the
// round-trip writer can recreate the same structure gsd-core wrote.
//
// This extracts the implicit 3-way branch that was buried in transformer.ts
// transformToGSD (lines 425-467). Priority matches the transformer's if/else
// chain: legacy-milestone-dir > multi-milestone > flat-phases.

import type { PlanningProject } from "./types.js";
import type { PlanningLayout } from "../compat/compat-marker.js";

/**
 * Determine which .planning/ layout a parsed project uses. Returns null when
 * no layout signal is present (caller decides: treat as inactive or error).
 *
 * Priority (must match transformer.ts transformToGSD):
 *   1. legacy-milestone-dir — milestones/<id>/ contains <id>-phases/ subdirs
 *      with phase content. Detected when parsed.milestones has any entry with
 *      non-empty phases.
 *   2. multi-milestone — ROADMAP.md parsed into milestone sections.
 *      Detected when roadmap.milestones.length > 0.
 *   3. flat-phases — ROADMAP.md parsed into checkbox phase lines only.
 *      Detected when roadmap.phases.length > 0.
 */
export function detectPlanningLayout(parsed: PlanningProject): PlanningLayout | null {
  const hasMilestoneDirectories = parsed.milestones.some(
    (m) => Object.keys(m.phases).length > 0,
  );
  if (hasMilestoneDirectories) return "legacy-milestone-dir";

  const isMultiMilestone = parsed.roadmap !== null && parsed.roadmap.milestones.length > 0;
  if (isMultiMilestone) return "multi-milestone";

  const hasFlatPhases = parsed.roadmap !== null && parsed.roadmap.phases.length > 0;
  if (hasFlatPhases) return "flat-phases";

  return null;
}
