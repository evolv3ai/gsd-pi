// Project/App: gsd-pi
// File Purpose: Guidance module — the single catalog mapping typed findings
// (Recovery kinds, milestone blocker kinds, doctor issue codes, crash unit
// classes) to user-facing remediation: what happened and what to do next.
//
// Emit sites pass the typed finding; phrasing, command names, and step
// ordering live here. A missing catalog row is a visible gap, not a silent
// omission scattered across call sites.

import type { RecoveryFailureKind } from "./recovery-classification.js";
import type { DoctorIssueCode } from "./doctor-types.js";

// ─── Shape ──────────────────────────────────────────────────────────────

export interface Guidance {
  summary: string;
  steps: string[];
}

/** Flatten guidance into a notification / pause-banner string. */
export function formatGuidance(guidance: Guidance): string {
  if (guidance.steps.length === 0) return guidance.summary;
  const numbered = guidance.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return `${guidance.summary}\n\n${numbered}`;
}

// ─── Recovery Classification remediation ────────────────────────────────
// Keyed by RecoveryFailureKind. The provider kind is split by transience,
// which Recovery Classification resolves before looking up guidance.

export type RecoveryGuidanceKey =
  | Exclude<RecoveryFailureKind, "provider">
  | "provider-transient"
  | "provider-permanent";

const RECOVERY_REMEDIATION: Record<RecoveryGuidanceKey, string> = {
  "tool-schema": "Fix the Unit Tool Contract or tool schema before retrying.",
  "tool-contract":
    "Fix the Unit Tool Contract or prompt so the Unit is only asked to use tools owned by its phase.",
  "tool-unavailable":
    "The tool surface had not finished registering when the Unit called it (workflow MCP startup race). Retry after the surface is ready; escalate if the tool never appears.",
  "deterministic-policy": "Resolve the policy blocker; retrying the same Unit will repeat the failure.",
  "lifecycle-progression":
    "Route to the required owning Unit or restore the missing artifact before advancing lifecycle state.",
  "stale-worker":
    "Run `/gsd doctor` to detect and clear the stale worker or lock, then run `/gsd auto` to resume.",
  "worktree-invalid":
    "Run `/gsd doctor` to diagnose the milestone worktree (`gsd worktree list` shows its state). Repair it, or merge salvageable work with `gsd worktree merge <name>` before recreating — recreating discards uncommitted work.",
  "verification-drift":
    "Run `/gsd status` to see the verification finding, fix or re-run the verification, then run `/gsd auto` to resume. `/gsd doctor` can repair stale state files.",
  "reconciliation-drift":
    "Run `/gsd doctor` to surface the persistent or repair-failed drift kinds, apply its fixes, then run `/gsd auto` to resume.",
  "illegal-transition":
    "A derived Phase edge rejected by the Phase Transition Invariant survived reconciliation; inspect deriveState and the State Reconciliation Module before resuming.",
  "runtime-unknown": "Inspect the runtime error and add a dedicated classification if it is repeatable.",
  "provider-transient": "Retry after the provider/network condition clears.",
  "provider-permanent": "Inspect provider credentials, model entitlement, or request shape.",
};

export function recoveryRemediation(key: RecoveryGuidanceKey): string {
  return RECOVERY_REMEDIATION[key];
}

// ─── Milestone validation blockers ──────────────────────────────────────
// NOTE: the first line of each blocker is load-bearing — validation-block-guard
// matches /milestone validation returned needs-(?:attention|remediation)/i.
// Keep that phrase intact when editing.

export function needsAttentionBlockerGuidance(milestoneId: string): string {
  return [
    `Milestone ${milestoneId} is blocked because milestone validation returned needs-attention.`,
    `Fix options:`,
    `1. Review the validation details: \`/gsd status\``,
    `2. If you fixed the missing evidence or issue, re-run milestone validation: \`/gsd validate-milestone\``,
    `3. If the finding is acceptable, override it: \`/gsd verdict pass --rationale "why this is okay"\``,
    `4. If this should wait, defer it explicitly: \`/gsd park ${milestoneId}\``,
    `After validation or override passes, run \`/gsd auto\` to complete and merge the milestone.`,
  ].join("\n");
}

export function needsRemediationBlockerGuidance(milestoneId: string): string {
  return [
    `Milestone ${milestoneId} is blocked because milestone validation returned needs-remediation, but all slices are complete.`,
    `Fix options:`,
    `1. Run \`/gsd dispatch reassess\` to add remediation slices, then run \`/gsd auto\``,
    `2. If the finding is acceptable, override it: \`/gsd verdict pass --rationale "why this is okay"\``,
    `3. If this should wait, defer it explicitly: \`/gsd park ${milestoneId}\``,
  ].join("\n");
}

// ─── Crash recovery resume hints ────────────────────────────────────────

/** Resume hint for an interrupted auto-mode unit, by unit class. */
export function crashResumeHint(unitType: string, unitId: string): string | undefined {
  if (unitType === "starting" && unitId === "bootstrap") {
    return `No work was lost. Run /gsd auto to restart.`;
  }
  if (unitType.includes("research") || unitType.includes("plan")) {
    return `The ${unitType} unit may be incomplete. Run /gsd auto to re-run it.`;
  }
  if (unitType.includes("execute")) {
    return `Task execution was interrupted. Run /gsd auto to resume — completed work is preserved.`;
  }
  if (unitType.includes("complete")) {
    return `Slice/milestone completion was interrupted. Run /gsd auto to finish.`;
  }
  return undefined;
}

// ─── Doctor issue fix hints ─────────────────────────────────────────────
// Partial by design: codes without a row render no hint. Add rows here as
// guidance is authored — the gap is visible in one place.

const DOCTOR_FIX_HINTS: Partial<Record<DoctorIssueCode, string>> = {
  db_unavailable:
    "The workflow database could not be opened — state derivation is degraded. Restart the session; if it persists, run `/gsd doctor` from the project root.",
  stale_crash_lock: "Run `/gsd doctor` to clear the stale lock, then `/gsd auto` to resume.",
  stale_parallel_session: "Run `/gsd doctor` to clear the stale session registration.",
  unresolved_git_conflicts:
    "Resolve the conflict markers, commit, then re-run `/gsd auto`.",
  conflict_markers_in_tracked_files:
    "Search the listed files for `<<<<<<<` markers, resolve, and commit.",
  worktree_dirty:
    "Commit or merge the worktree's changes (`gsd worktree merge <name>`) before removing it.",
  worktree_branch_merged: "The branch is merged — remove the worktree to reclaim space.",
  orphaned_auto_worktree: "Run `/gsd doctor` to fix, or merge salvageable work with `gsd worktree merge <name>`.",
  gitignore_missing_patterns: "Run `/gsd doctor` to append the missing .gitignore patterns.",
  invalid_preferences: "Edit .gsd/PREFERENCES.md to fix the invalid field, then re-run the command.",
  provider_key_missing: "Add the provider API key to your environment or provider config, then retry.",
  provider_key_backedoff: "The key is cooling down after repeated failures — wait, or switch the phase model in .gsd/PREFERENCES.md.",
  state_file_stale: "Run `/gsd doctor` to rebuild the projection from the database.",
  state_file_missing: "Run `/gsd doctor` to rebuild the projection from the database.",
  projection_drift: "Run `/gsd doctor` to rebuild markdown projections from the database (DB is the source of truth).",
  uat_retry_exhausted: "Review the failing UAT criteria via `/gsd status`, fix the issue, then re-run `/gsd auto`.",
};

export function doctorFixHint(code: DoctorIssueCode): string | undefined {
  return DOCTOR_FIX_HINTS[code];
}
