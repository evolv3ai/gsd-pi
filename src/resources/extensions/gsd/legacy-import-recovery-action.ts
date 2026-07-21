// Project/App: gsd-pi
// File Purpose: Execute an explicitly requested recovery action from one verified Import Application.

import {
  persistVerifiedRecoverRestoreApproval,
  type VerifiedRecoverApplicationResult,
} from "./db-workspace.js";
import {
  applyLegacyImportForwardRepair,
  inspectLegacyImportForwardRepair,
  replayLegacyImportForwardRepair,
  type LegacyImportForwardRepairResult,
} from "./legacy-import-forward-repair.js";
import type { LegacyImportForwardRepairChoice, LegacyImportForwardRepairGoal } from "./legacy-import-forward-repair-plan.js";
import { canonicalLegacyImportJson } from "./legacy-import-preview.js";
import type { LegacyImportValue } from "./legacy-import-contract.js";
import {
  restoreLegacyImportLive,
  replayLegacyImportLiveRestore,
  type LegacyImportLiveRestoreResult,
} from "./legacy-import-live-restore.js";
import {
  assessLegacyImportRestore,
  type LegacyImportRestoreAssessment,
  type LegacyImportRestoreAssessmentConsent,
} from "./legacy-import-restore-assessment.js";

export type LegacyImportRecoveryAction = "assess" | "restore" | "forward-repair";

export function parseLegacyImportRecoveryAction(
  flags: readonly string[],
): LegacyImportRecoveryAction {
  const restore = flags.includes("--restore");
  const forwardRepair = flags.includes("--forward-repair");
  if (restore && forwardRepair) {
    throw new Error("--restore and --forward-repair are mutually exclusive");
  }
  if (restore) return "restore";
  if (forwardRepair) return "forward-repair";
  return "assess";
}

export type LegacyImportRecoveryActionErrorStage = "restore" | "forward-repair";

export type LegacyImportRecoveryActionErrorCode =
  | "LEGACY_IMPORT_RECOVERY_ACTION_CONSENT_REQUIRED"
  | "LEGACY_IMPORT_RECOVERY_ACTION_RESTORE_UNAVAILABLE"
  | "LEGACY_IMPORT_RECOVERY_ACTION_CONSENT_INELIGIBLE"
  | "LEGACY_IMPORT_RECOVERY_ACTION_FORWARD_REPAIR_UNAVAILABLE"
  | "LEGACY_IMPORT_RECOVERY_ACTION_REVIEW_EVIDENCE_INCOMPLETE";

/**
 * Typed action-boundary failure, matching the stage/code/retryability
 * convention used by the restore and Forward Repair subsystems. Every code
 * is a deliberate non-retryable refusal: the caller must change its request
 * (supply Consent, supply choices, or pick the assessed route) rather than
 * retry the identical action.
 */
export class LegacyImportRecoveryActionError extends Error {
  readonly stage: LegacyImportRecoveryActionErrorStage;
  readonly code: LegacyImportRecoveryActionErrorCode;
  readonly retryable: false;

  constructor(
    stage: LegacyImportRecoveryActionErrorStage,
    code: LegacyImportRecoveryActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyImportRecoveryActionError";
    this.stage = stage;
    this.code = code;
    this.retryable = false;
  }
}

function fail(
  stage: LegacyImportRecoveryActionErrorStage,
  code: LegacyImportRecoveryActionErrorCode,
  message: string,
): never {
  throw new LegacyImportRecoveryActionError(stage, code, message);
}

export type LegacyImportRecoveryActionResult =
  | { readonly status: "assessed"; readonly assessment: LegacyImportRestoreAssessment }
  | { readonly status: "restored"; readonly result: LegacyImportLiveRestoreResult }
  | { readonly status: "forward-repaired"; readonly result: LegacyImportForwardRepairResult }
  | {
      readonly status: "choice-required";
      readonly assessment: LegacyImportRestoreAssessment;
      readonly choices: readonly {
        instructionIndex: number;
        targetKind: string;
        targetKey: string;
        reasonCode: string;
        reviewHash: string;
        currentValueJson: string;
        proposedMutationJson: string;
        recommendedDecision: "preserve-later";
        recommendationRationale: string;
      }[];
    };

export function executeLegacyImportRecoveryAction(
  application: Readonly<VerifiedRecoverApplicationResult>,
  action: LegacyImportRecoveryAction,
  choices: readonly Readonly<LegacyImportForwardRepairChoice>[] = [],
  consent?: Readonly<LegacyImportRestoreAssessmentConsent>,
  goal: LegacyImportForwardRepairGoal = "revert",
): LegacyImportRecoveryActionResult {
  const assessmentInput = {
    applicationIdentityHash: application.receipt.applicationIdentityHash,
    backup: application.backup,
  };
  const assessment = assessLegacyImportRestore(assessmentInput);
  if (action === "assess") return { status: "assessed", assessment };

  if (action === "restore") {
    if (!consent) {
      fail("restore", "LEGACY_IMPORT_RECOVERY_ACTION_CONSENT_REQUIRED", "destructive restore requires explicit evidence-bound Consent");
    }
    const invocation = {
      idempotencyKey: `legacy-import/recover-restore/${application.receipt.applicationIdentityHash}`,
      sourceTransport: "internal" as const,
      actorType: "system" as const,
      actorId: "gsd-recover",
    };
    if (assessment.decision === "already-restored") {
      return { status: "restored", result: replayLegacyImportLiveRestore({ ...assessmentInput, consent }) };
    }
    if (assessment.decision === "transaction-rollback-only" && application.restoreApproval) {
      if (canonicalLegacyImportJson(consent as unknown as LegacyImportValue)
        !== canonicalLegacyImportJson(application.restoreApproval.consent as unknown as LegacyImportValue)) {
        throw new Error("destructive restore Consent does not match the retained approval");
      }
      return {
        status: "restored",
        result: restoreLegacyImportLive({
          invocation,
          applicationIdentityHash: application.receipt.applicationIdentityHash,
          backup: application.backup,
          assessment: application.restoreApproval.assessment,
          consent: application.restoreApproval.consent,
        }),
      };
    }
    if (assessment.decision !== "restore-consent-required") {
      fail("restore", "LEGACY_IMPORT_RECOVERY_ACTION_RESTORE_UNAVAILABLE", `destructive restore is unavailable: ${assessment.reasonCode}`);
    }
    const eligible = assessLegacyImportRestore({ ...assessmentInput, consent });
    if (eligible.decision !== "restore-eligible") {
      fail("restore", "LEGACY_IMPORT_RECOVERY_ACTION_CONSENT_INELIGIBLE", `destructive restore Consent became ineligible: ${eligible.reasonCode}`);
    }
    persistVerifiedRecoverRestoreApproval(application, eligible, consent);
    return {
      status: "restored",
      result: restoreLegacyImportLive({
        invocation,
        applicationIdentityHash: application.receipt.applicationIdentityHash,
        backup: application.backup,
        assessment: eligible,
        consent,
      }),
    };
  }

  if (assessment.reasonCode === "FORWARD_REPAIR_ALREADY_COMMITTED") {
    return { status: "forward-repaired", result: replayLegacyImportForwardRepair(assessmentInput) };
  }
  if (assessment.decision !== "forward-repair-required") {
    fail("forward-repair", "LEGACY_IMPORT_RECOVERY_ACTION_FORWARD_REPAIR_UNAVAILABLE", `Forward Repair is unavailable: ${assessment.reasonCode}`);
  }
  const plan = inspectLegacyImportForwardRepair({ ...assessmentInput, choices }, goal);
  if (plan.unresolvedCount !== 0) {
    const unresolvedTargets = plan.targets.filter((target) => (
      target.disposition === "choice-required" && target.reviewHash !== null && target.review !== null
    ));
    if (unresolvedTargets.length !== plan.unresolvedCount) {
      fail("forward-repair", "LEGACY_IMPORT_RECOVERY_ACTION_REVIEW_EVIDENCE_INCOMPLETE", "Forward Repair review evidence is incomplete");
    }
    return {
      status: "choice-required",
      assessment,
      choices: unresolvedTargets
        .map((target) => ({
          instructionIndex: target.instructionIndex,
          targetKind: target.targetKind,
          targetKey: target.targetKey,
          reasonCode: target.reasonCode,
          reviewHash: target.reviewHash as string,
          currentValueJson: canonicalLegacyImportJson(target.review!.currentValue),
          proposedMutationJson: canonicalLegacyImportJson(target.review!.proposedMutation as unknown as LegacyImportValue),
          recommendedDecision: target.review!.recommendedDecision,
          recommendationRationale: target.review!.recommendationRationale,
        })),
    };
  }
  return {
    status: "forward-repaired",
    result: applyLegacyImportForwardRepair({
      ...assessmentInput,
      choices,
      invocation: {
        idempotencyKey: `legacy-import/recover-forward-repair/${application.receipt.applicationIdentityHash}/${plan.differenceHash}`,
        sourceTransport: "internal",
        actorType: "system",
        actorId: "gsd-recover",
      },
      plan,
    }),
  };
}
