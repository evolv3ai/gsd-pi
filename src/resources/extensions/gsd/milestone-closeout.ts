// Project/App: gsd-pi
// File Purpose: Coordinates milestone closeout phases across dispatch, post-unit, and recovery.
//
// - preflight: dispatch git clean before complete-milestone agent (auto-dispatch)
// - postUnit: git commit, artifact verify, DB settle, then GitHub finalize
// - recovery: DB repair from artifacts, then GitHub finalize

import { loadFile } from "./files.js";
import { parseRoadmap } from "./parsers-legacy.js";
import { resolveMilestoneFile } from "./paths.js";
import { getMilestone, getMilestoneSlices, isDbAvailable } from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { verifyExpectedArtifact } from "./auto-recovery.js";
import { runSafely } from "./auto-utils.js";
import { extractVerdict, isAcceptableUatVerdict } from "./verdict-parser.js";
import { logWarning } from "./workflow-logger.js";
import { hasImplementationArtifacts } from "./milestone-implementation-evidence.js";
import { buildCompleteMilestonePrompt } from "./auto-prompts.js";
import { checkCloseoutConsistencyGate } from "./closeout-consistency-gate.js";
import type { DispatchAction, DispatchContext } from "./auto-dispatch.js";
import {
  commitPendingMilestoneCloseoutChanges,
  findMissingSummaries,
  isVerificationNotApplicable,
  readUatGateVerdict,
} from "./auto-dispatch.js";

const COMPLETE_MILESTONE_DB_SETTLE_MS = 1500;
const COMPLETE_MILESTONE_DB_SETTLE_POLL_MS = 100;

/**
 * True when the milestone is closed in the DB and the completion summary artifact exists.
 * Polls briefly so post-unit verification can observe the tool's DB write.
 */
export async function isMilestoneCloseoutSettled(mid: string, basePath: string): Promise<boolean> {
  const deadline = Date.now() + COMPLETE_MILESTONE_DB_SETTLE_MS;
  while (Date.now() < deadline) {
    if (isDbAvailable()) {
      const milestone = getMilestone(mid);
      if (milestone && isClosedStatus(milestone.status)) {
        const closeoutGate = checkCloseoutConsistencyGate(mid, { refreshFromDisk: true });
        if (closeoutGate.ok && verifyExpectedArtifact("complete-milestone", mid, basePath)) {
          return true;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, COMPLETE_MILESTONE_DB_SETTLE_POLL_MS));
  }
  return false;
}

/** Non-blocking GitHub milestone close after local closeout has settled. */
export async function runMilestoneCloseoutGitHub(basePath: string, mid: string): Promise<void> {
  await runSafely("postUnit", "github-sync", async () => {
    const { finalizeMilestoneGitHubSync } = await import("../github-sync/sync.js");
    await finalizeMilestoneGitHubSync(basePath, mid);
  });
}

/**
 * Dispatch policy for completing-milestone → complete-milestone.
 * Returns null when the phase does not match or guards do not apply.
 */
export async function evaluateCompleteMilestoneDispatch(
  ctx: DispatchContext,
): Promise<DispatchAction | null> {
  const { state, mid, midTitle, basePath, prefs } = ctx;
  if (state.phase !== "completing-milestone") return null;

  if (isDbAvailable()) {
    const milestone = getMilestone(mid);
    if (milestone && isClosedStatus(milestone.status)) {
      return { action: "skip" };
    }
  }

  const closeoutGitStop = commitPendingMilestoneCloseoutChanges(basePath, mid);
  if (closeoutGitStop) return closeoutGitStop;

  if (prefs?.uat_dispatch) {
    let closedSliceIds: string[];
    if (isDbAvailable()) {
      closedSliceIds = getMilestoneSlices(mid)
        .filter((slice) => isClosedStatus(slice.status))
        .map((slice) => slice.id);
    } else {
      const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
      const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
      if (!roadmapContent) {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: unable to verify UAT verdicts because ROADMAP is unavailable while DB is not accessible.`,
          level: "warning",
        };
      }
      const roadmap = parseRoadmap(roadmapContent);
      closedSliceIds = roadmap.slices.filter((slice) => slice.done).map((slice) => slice.id);
    }

    for (const sliceId of closedSliceIds) {
      const result = await readUatGateVerdict(basePath, mid, sliceId);
      if (!result) {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: missing UAT PASS verdict for ${sliceId}. Manual UAT sign-off (PASS) is required before milestone closure.`,
          level: "warning",
        };
      }
      const { verdict, uatType } = result;
      if (!isAcceptableUatVerdict(verdict, uatType)) {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: UAT verdict for ${sliceId} is "${verdict}". Manual UAT sign-off (PASS) is required before milestone closure.`,
          level: "warning",
        };
      }
    }
  }

  const validationFile = resolveMilestoneFile(basePath, mid, "VALIDATION");
  if (validationFile) {
    const validationContent = await loadFile(validationFile);
    if (validationContent) {
      const verdict = extractVerdict(validationContent);
      if (verdict !== "pass") {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: VALIDATION verdict is "${verdict}". Address the validation findings and re-run validation, or run \`/gsd verdict pass --rationale "..."\` to override.`,
          level: "warning",
        };
      }
    }
  }

  const missingSlices = findMissingSummaries(basePath, mid);
  if (missingSlices.length > 0) {
    return {
      action: "stop",
      reason: `Cannot complete milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. Run /gsd doctor to diagnose.`,
      level: "error",
    };
  }

  const artifactCheck = hasImplementationArtifacts(basePath, mid);
  if (artifactCheck === "absent") {
    logWarning("dispatch", `Milestone ${mid} has no implementation files outside .gsd/ — continuing complete-milestone dispatch (planning-only/documentation-only milestone).`);
  }
  if (artifactCheck === "unknown") {
    logWarning("dispatch", `Implementation artifact check inconclusive for ${mid} — proceeding (git context unavailable)`);
  }

  try {
    if (isDbAvailable()) {
      const milestone = getMilestone(mid);
      if (milestone?.verification_operational &&
          !isVerificationNotApplicable(milestone.verification_operational)) {
        const validationPath = resolveMilestoneFile(basePath, mid, "VALIDATION");
        if (validationPath) {
          const validationContent = await loadFile(validationPath);
          if (validationContent) {
            const skippedByMarker = /^skip_validation:\s*true$/im.test(validationContent);
            const skippedByPreference = /skip(?:ped)?[\s\-]+(?:by|per|due to)\s+(?:preference|budget|profile)/i.test(validationContent);
            const skippedByTrivialVariant = /trivial-scope pipeline variant/i.test(validationContent);
            const structuredMatch =
              validationContent.includes("Operational") &&
              (validationContent.includes("MET") || validationContent.includes("N/A") || validationContent.includes("SATISFIED") || validationContent.includes("DEFERRED"));
            const proseMatch =
              /[Oo]perational[\s\S]{0,500}?(?:✅|pass|verified|confirmed|met|complete|true|yes|addressed|covered|satisfied|partially|deferred|n\/a|not[\s-]+applicable)/i.test(validationContent);
            const hasOperationalCheck =
              skippedByMarker ||
              skippedByPreference ||
              skippedByTrivialVariant ||
              structuredMatch ||
              proseMatch;
            if (!hasOperationalCheck) {
              return {
                action: "stop",
                reason: `Milestone ${mid} has planned operational verification ("${milestone.verification_operational.substring(0, 100)}") but the validation output does not address it. Re-run validation with verification class awareness, or update the validation to document operational compliance.`,
                level: "warning",
              };
            }
          }
        }
      }
    }
  } catch (err) {
    logWarning("dispatch", `verification class check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    action: "dispatch",
    unitType: "complete-milestone",
    unitId: mid,
    prompt: await buildCompleteMilestonePrompt(mid, midTitle, basePath),
  };
}
