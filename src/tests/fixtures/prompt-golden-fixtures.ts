// Project/App: gsd-pi
// File Purpose: Shared prompt fixture definitions for Phase 0 characterization and Phase 2 reduction targets.

export const promptGoldenUnits = [
  {
    unitType: "plan-slice",
    phase2StartChars: 19259,
    requiredMarkers: [
      "UNIT: Plan Slice S01",
      "Inlined Context",
      "gsd_plan_slice",
      "Baseline Slice",
    ],
  },
  {
    unitType: "execute-task",
    // Tool Surface guidance and related prompt additions have grown this prompt;
    // the baseline is adjusted so the gate still tracks shrinkage from the
    // original oversized prompts while allowing today's ~8586-char fixture.
    phase2StartChars: 14320,
    requiredMarkers: [
      "UNIT: Execute Task T01",
      "Inlined Task Plan",
      "Background process rule",
      "Verification Evidence",
      "blocker_discovered",
      "gsd_task_complete",
      "Implement baseline harness",
    ],
  },
  {
    unitType: "complete-slice",
    // Tool Surface guidance and subsequent feature additions (most recently,
    // explicit terminal-handoff stop rules for gsd_task_reopen/gsd_replan_slice
    // per issue #846) have grown this prompt; the baseline is adjusted so the
    // gate still tracks shrinkage from the original oversized prompts while
    // allowing today's ~9154-char fixture.
    phase2StartChars: 15400,
    requiredMarkers: [
      "UNIT: Complete Slice S01",
      "Tool Surface",
      "Inlined Context",
      "gsd_slice_complete",
      "Slice Summary",
    ],
  },
] as const;

export type PromptGoldenUnitType = typeof promptGoldenUnits[number]["unitType"];
