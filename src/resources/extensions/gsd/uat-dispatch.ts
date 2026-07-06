// Project/App: gsd-pi
// File Purpose: Resolve whether a completed slice needs run-uat dispatch.

import { loadFile } from "./files.js";
import type { GSDPreferences } from "./preferences.js";
import { resolveSliceFile } from "./paths.js";
import {
  classifyUatContentForRun,
  shouldDispatchUatForContent,
  type UatType,
} from "./uat-policy.js";
import { hasVerdict } from "./verdict-parser.js";
import { logWarning } from "./workflow-logger.js";

export interface UatDispatchCandidate {
  sliceId: string;
}

export type RunUatDispatch = { sliceId: string; uatType: UatType };

async function loadSliceFileContent(
  base: string,
  milestoneId: string,
  sliceId: string,
  kind: "UAT" | "ASSESSMENT" | "SUMMARY",
): Promise<string> {
  const filePath = resolveSliceFile(base, milestoneId, sliceId, kind);
  return filePath ? ((await loadFile(filePath)) ?? "") : "";
}

async function resolveRunUatEffectiveType(
  base: string,
  milestoneId: string,
  sliceId: string,
  uatContent: string,
): Promise<UatType> {
  let summaryContent = "";
  try {
    summaryContent = await loadSliceFileContent(
      base,
      milestoneId,
      sliceId,
      "SUMMARY",
    );
  } catch (err) {
    logWarning(
      "prompt",
      `resolveRunUatEffectiveType SUMMARY load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return classifyUatContentForRun(uatContent, summaryContent).effectiveType;
}

async function resolveCandidateRunUatDispatch(
  base: string,
  milestoneId: string,
  candidate: UatDispatchCandidate,
  prefs: GSDPreferences | undefined,
): Promise<RunUatDispatch | null> {
  const uatContent = await loadSliceFileContent(
    base,
    milestoneId,
    candidate.sliceId,
    "UAT",
  );
  if (!uatContent) return null;
  if (hasVerdict(uatContent)) return null;

  const assessmentContent = await loadSliceFileContent(
    base,
    milestoneId,
    candidate.sliceId,
    "ASSESSMENT",
  );
  if (assessmentContent && hasVerdict(assessmentContent)) return null;
  if (!shouldDispatchUatForContent(uatContent, prefs)) return null;

  return {
    sliceId: candidate.sliceId,
    uatType: await resolveRunUatEffectiveType(
      base,
      milestoneId,
      candidate.sliceId,
      uatContent,
    ),
  };
}

async function getDbCompletedSliceCandidates(
  milestoneId: string,
): Promise<UatDispatchCandidate[] | null> {
  const { isDbAvailable, getMilestoneSlices } = await import("./gsd-db.js");
  if (!isDbAvailable()) return null;

  const slices = getMilestoneSlices(milestoneId);
  // No DB slice rows for this milestone: the DB has no authoritative view, so
  // return null to let the caller defer to the roadmap fallback.
  if (slices.length === 0) return null;

  // The DB has slice rows and is therefore authoritative for this milestone.
  // Return a (possibly empty) array rather than null: an empty result must NOT
  // fall through to the roadmap fallback, because the DB, not stale roadmap
  // checkboxes, is the source of truth for which slices are complete.
  return slices
    .filter((slice) => slice.status === "complete")
    .map((slice) => ({ sliceId: slice.id }))
    .reverse();
}

export async function findRunUatDispatchFromCandidates(
  base: string,
  milestoneId: string,
  candidates: readonly UatDispatchCandidate[],
  prefs: GSDPreferences | undefined,
): Promise<RunUatDispatch | null> {
  for (const candidate of candidates) {
    const dispatch = await resolveCandidateRunUatDispatch(
      base,
      milestoneId,
      candidate,
      prefs,
    );
    if (dispatch) return dispatch;
  }
  return null;
}

/**
 * Check if the most recently completed slice needs a UAT run.
 * Returns { sliceId, uatType } if UAT should be dispatched, null otherwise.
 *
 * When the DB has slice rows for the milestone it is authoritative: only its
 * completed slices are considered and the `fallbackCandidates` (roadmap-derived)
 * are ignored, even when no DB slice is complete. The fallback candidates are
 * only consulted when the DB has no slice rows for the milestone, is
 * unavailable, or errors.
 *
 * Skips when:
 * - No completed slices exist in DB or the caller-provided fallback candidates
 * - uat_dispatch is not enabled and the UAT spec does not require runtime/browser evidence
 * - No UAT file exists for the slice
 * - UAT result already exists in the UAT or ASSESSMENT file
 */
export async function checkNeedsRunUat(
  base: string,
  milestoneId: string,
  prefs: GSDPreferences | undefined,
  fallbackCandidates: readonly UatDispatchCandidate[] = [],
): Promise<RunUatDispatch | null> {
  try {
    const dbCandidates = await getDbCompletedSliceCandidates(milestoneId);
    // A non-null result (including an empty array) means the DB is authoritative
    // for this milestone; only fall through to the roadmap fallback when the DB
    // has no slice rows at all (null).
    if (dbCandidates !== null) {
      return findRunUatDispatchFromCandidates(
        base,
        milestoneId,
        dbCandidates,
        prefs,
      );
    }
  } catch (err) {
    logWarning(
      "prompt",
      `checkNeedsRunUat DB lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return findRunUatDispatchFromCandidates(
    base,
    milestoneId,
    fallbackCandidates,
    prefs,
  );
}
