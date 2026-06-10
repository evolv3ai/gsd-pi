// Project/App: gsd-pi
// File Purpose: ADR-015 Recovery Classification module for runtime failure taxonomy.

import { isToolUnavailableError } from "./auto-tool-tracking.js";
import { classifyError, isTransient, type ErrorClass } from "./error-classifier.js";
import { ReconciliationFailedError } from "./state-reconciliation.js";
import { IllegalPhaseTransitionError } from "./state-transition-matrix.js";

export type RecoveryFailureKind =
  | "tool-schema"
  | "tool-contract"
  | "tool-unavailable"
  | "deterministic-policy"
  | "lifecycle-progression"
  | "stale-worker"
  | "worktree-invalid"
  | "verification-drift"
  | "reconciliation-drift"
  | "illegal-transition"
  | "provider"
  | "runtime-unknown";

export type RecoveryAction = "retry" | "escalate" | "stop";

export interface RecoveryClassificationInput {
  error: unknown;
  unitType?: string;
  unitId?: string;
  failureKind?: RecoveryFailureKind;
  retryAfterMs?: number;
}

export interface RecoveryClassification {
  failureKind: RecoveryFailureKind;
  action: RecoveryAction;
  reason: string;
  exitReason: string;
  remediation: string;
  providerClass?: ErrorClass["kind"];
}

export function classifyFailure(input: RecoveryClassificationInput): RecoveryClassification {
  const message = errorMessage(input.error);
  // ADR-017: ReconciliationFailedError is a typed throw from the State
  // Reconciliation Module. Recognize it by class regardless of caller-supplied
  // failureKind so the taxonomy stays consistent.
  const failureKind =
    input.error instanceof ReconciliationFailedError
      ? "reconciliation-drift"
      : input.error instanceof IllegalPhaseTransitionError
        ? "illegal-transition"
        : input.failureKind ?? inferFailureKind(message);

  switch (failureKind) {
    case "tool-schema":
      return {
        failureKind,
        action: "stop",
        reason: `Tool schema failure${unitSuffix(input)}: ${message}`,
        exitReason: "tool-schema",
        remediation: "Fix the Unit Tool Contract or tool schema before retrying.",
      };
    case "tool-contract":
      return {
        failureKind,
        action: "stop",
        reason: `Tool Contract failure${unitSuffix(input)}: ${message}`,
        exitReason: "tool-contract",
        remediation: "Fix the Unit Tool Contract or prompt so the Unit is only asked to use tools owned by its phase.",
      };
    case "tool-unavailable":
      return {
        failureKind,
        action: "retry",
        reason: `Tool unavailable${unitSuffix(input)}: ${message}`,
        exitReason: "tool-unavailable",
        remediation:
          "The tool surface had not finished registering when the Unit called it (workflow MCP startup race). Retry after the surface is ready; escalate if the tool never appears.",
      };
    case "deterministic-policy":
      return {
        failureKind,
        action: "stop",
        reason: `Deterministic policy failure${unitSuffix(input)}: ${message}`,
        exitReason: "deterministic-policy",
        remediation: "Resolve the policy blocker; retrying the same Unit will repeat the failure.",
      };
    case "lifecycle-progression":
      return {
        failureKind,
        action: "stop",
        reason: `Lifecycle progression failure${unitSuffix(input)}: ${message}`,
        exitReason: "lifecycle-progression",
        remediation: "Route to the required owning Unit or restore the missing artifact before advancing lifecycle state.",
      };
    case "stale-worker":
      return {
        failureKind,
        action: "stop",
        reason: `Stale worker failure${unitSuffix(input)}: ${message}`,
        exitReason: "stale-worker",
        remediation: "Clear or reconcile the stale worker before dispatching another Unit.",
      };
    case "worktree-invalid":
      return {
        failureKind,
        action: "stop",
        reason: `Worktree invalid${unitSuffix(input)}: ${message}`,
        exitReason: "worktree-invalid",
        remediation: "Repair or recreate the milestone worktree before launching source-writing Units.",
      };
    case "verification-drift":
      return {
        failureKind,
        action: "escalate",
        reason: `Verification drift${unitSuffix(input)}: ${message}`,
        exitReason: "verification-drift",
        remediation: "Inspect the verification artifact and reconcile the state snapshot before resuming.",
      };
    case "reconciliation-drift":
      return {
        failureKind,
        action: "escalate",
        reason: `Reconciliation drift${unitSuffix(input)}: ${message}`,
        exitReason: "reconciliation-drift",
        remediation:
          "Inspect the persistent or repair-failed drift kinds reported by the State Reconciliation Module before resuming.",
      };
    case "illegal-transition":
      return {
        failureKind,
        action: "escalate",
        reason: `Illegal phase transition${unitSuffix(input)}: ${message}`,
        exitReason: "illegal-transition",
        remediation:
          "A derived Phase edge rejected by the Phase Transition Invariant survived reconciliation; inspect deriveState and the State Reconciliation Module before resuming.",
      };
    case "provider": {
      const providerClass = classifyError(message, input.retryAfterMs);
      return {
        failureKind,
        action: isTransient(providerClass) ? "retry" : "escalate",
        reason: message,
        exitReason: `provider-${providerClass.kind}`,
        remediation: isTransient(providerClass)
          ? "Retry after the provider/network condition clears."
          : "Inspect provider credentials, model entitlement, or request shape.",
        providerClass: providerClass.kind,
      };
    }
    case "runtime-unknown":
      return {
        failureKind,
        action: "escalate",
        reason: message,
        exitReason: "runtime-unknown",
        remediation: "Inspect the runtime error and add a dedicated classification if it is repeatable.",
      };
  }
}

function inferFailureKind(message: string): RecoveryFailureKind {
  if (isToolUnavailableError(message)) return "tool-unavailable";
  if (/tool contract|auto-unit tool scope|phase-boundary gate|not permitted.*own/i.test(message)) return "tool-contract";
  if (/lifecycle progression|required artifact|missing .*assessment|missing .*closeout|cannot legally (?:advance|progress)/i.test(message)) return "lifecycle-progression";
  if (/schema|invalid.*tool|tool.*invalid|enum/i.test(message)) return "tool-schema";
  if (/deterministic policy|policy rejection|write gate|blocked by policy/i.test(message)) return "deterministic-policy";
  if (/stale worker|stale lock|worker.*stale/i.test(message)) return "stale-worker";
  if (/worktree|\.git|unit root|git metadata/i.test(message)) return "worktree-invalid";
  if (/verification drift|assessment drift|state drift/i.test(message)) return "verification-drift";

  const providerClass = classifyError(message);
  return providerClass.kind === "unknown" ? "runtime-unknown" : "provider";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown runtime failure");
}

function unitSuffix(input: RecoveryClassificationInput): string {
  if (!input.unitType && !input.unitId) return "";
  return ` for ${input.unitType ?? "unit"} ${input.unitId ?? ""}`.trimEnd();
}
