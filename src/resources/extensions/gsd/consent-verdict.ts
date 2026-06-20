/**
 * Consent verdict leaf — the single per-question verdict engine shared by the
 * write gate (bootstrap/write-gate.ts) and the Consent Question module
 * (consent-question.ts).
 *
 * This module is a dependency leaf on purpose: write-gate consumes
 * evaluateGateAnswer here while consent-question imports write-gate's id
 * predicates, so putting the verdict anywhere else would create an import
 * cycle. It must not import from either module (ADR-039).
 */

export type GateAnswerVerdict = "waiting" | "verified" | "declined" | "cancelled";

export interface VerdictQuestionShape {
  id?: unknown;
  options?: Array<{ label?: string }>;
}

export interface VerdictAnswerDetails {
  cancelled?: boolean;
  interrupted?: boolean;
  response?: {
    answers?: Record<string, { selected?: unknown; notes?: unknown } | undefined>;
  } | null;
}

/**
 * Check whether a depth_verification answer confirms the discussion is complete.
 * Uses structural validation: the selected answer must exactly match the first
 * option label from the question definition (the confirmation option by convention).
 * This rejects free-form "Other" text, decline options, and garbage input without
 * coupling to any specific label substring.
 *
 * @param selected  The answer's selected value from details.response.answers[id].selected
 * @param options   The question's options array from event.input.questions[n].options
 */
export function isDepthConfirmationAnswer(
  selected: unknown,
  options?: Array<{ label?: string }>,
): boolean {
  const value = Array.isArray(selected) ? selected[0] : selected;
  if (typeof value !== "string" || !value) return false;

  // If options are available, structurally validate: selected must exactly match
  // the first option (confirmation) label. Rejects free-form "Other" and decline options.
  if (Array.isArray(options) && options.length > 0) {
    const confirmLabel = options[0]?.label;
    return typeof confirmLabel === "string" && value === confirmLabel;
  }

  // Fail-closed: no options means we cannot structurally validate the answer.
  // Returning false prevents any free-form string from unlocking the gate.
  return false;
}

export function hasSelectedValue(selected: unknown): boolean {
  if (Array.isArray(selected)) {
    return selected.some((value) => typeof value === "string" && value.length > 0);
  }
  return typeof selected === "string" && selected.length > 0;
}

export function hasNotesValue(notes: unknown): boolean {
  return typeof notes === "string" && notes.trim().length > 0;
}

/**
 * THE per-question verdict for gate questions (fail-closed):
 *
 * - cancelled rounds → "cancelled".
 * - the confirmation option (structural match) → "verified".
 * - any other real selection → "declined".
 * - empty/missing selection → "waiting" — an empty answer is NEVER an answer,
 *   so notes can never satisfy a gate either.
 */
export function evaluateGateAnswer(
  question: VerdictQuestionShape,
  details: VerdictAnswerDetails,
): GateAnswerVerdict {
  if (details.cancelled) return "cancelled";
  const questionId = typeof question.id === "string" ? question.id : "";
  const answer = details.response?.answers?.[questionId];
  if (isDepthConfirmationAnswer(answer?.selected, question.options)) return "verified";
  if (hasSelectedValue(answer?.selected)) return "declined";
  return "waiting";
}
