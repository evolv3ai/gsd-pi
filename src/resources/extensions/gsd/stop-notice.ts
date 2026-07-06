// Project/App: gsd-pi
// File Purpose: Stop Notice module — single owner of the auto/step-mode
// stop/pause notice vocabulary. Both sides of the wire live here: the
// formatters that produce the canonical prefixes (used by stopAuto/pauseAuto)
// and the classifiers that recognize them (used by the headless host to pick
// exit codes). Wording changes in this file keep emitter and detector in
// lockstep; round-trip tests enforce it.

export type StopNoticeKind = "stopped" | "blocked";

/** A reason string of the form "Blocked: …" marks a blocked stop. */
export function isBlockedStopReason(reason?: string | null): boolean {
  return /^Blocked:\s*/i.test(reason ?? "");
}

/** Strip the "Blocked: " marker for display. */
export function stopNoticeDisplayReason(reason?: string | null): string {
  return (reason ?? "").replace(/^Blocked:\s*/i, "").trim();
}

export function stopNoticeKind(reason?: string | null): StopNoticeKind {
  return isBlockedStopReason(reason) ? "blocked" : "stopped";
}

/** Canonical stop-notice prefix: "Auto-mode blocked — reason" / "Auto-mode stopped". */
export function formatStopNoticePrefix(reason?: string | null): string {
  const displayReason = stopNoticeDisplayReason(reason);
  const prefix = stopNoticeKind(reason) === "blocked" ? "Auto-mode blocked" : "Auto-mode stopped";
  return displayReason ? `${prefix} — ${displayReason}` : prefix;
}

// ─── Classification (headless host side) ────────────────────────────────
// The canonical lowercase prefixes the headless event loop recognizes in
// notify messages. Emitters above and ad-hoc emitters elsewhere must start
// their terminal notices with one of these.

export const PAUSED_NOTICE_PREFIXES = ["auto-mode paused", "step-mode paused"] as const;

export const TERMINAL_NOTICE_PREFIXES = [
  "auto-mode stopped",
  "step-mode stopped",
  "auto-mode complete",
  "no active milestone",
  "auto-mode idle",
] as const;

/** Manual-resolution notices emitted before auto-mode can formally pause/stop. */
export function isManualResolutionNotice(message: string): boolean {
  return (
    message.includes("resolve manually and re-run /gsd auto") ||
    message.includes("resolve conflicts manually and run /gsd auto to resume") ||
    message.includes("resolve and run /gsd auto to resume")
  );
}

export function isPauseNotice(message: string): boolean {
  return PAUSED_NOTICE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export function isTerminalNotice(message: string): boolean {
  return TERMINAL_NOTICE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/** Pauses that do not require operator intervention in headless mode. */
export function isNonBlockingPauseNotice(message: string): boolean {
  return message.includes("idempotent advance: unit already active");
}

/**
 * A picker / next-action menu that could not render in a non-interactive
 * (headless / RPC) session. Both wordings originate from the menu-unavailable
 * helpers (`notifyCommandMenuUnavailable` and `notifyPickerCommandNeedsInteractiveMenu`
 * in next-action-ui.ts / command-feedback.ts). Headless `auto`/`next` cannot
 * answer such a menu, so the run has dead-ended and needs operator intervention.
 * Classify it as blocked so the headless host exits 10 instead of idling
 * forever waiting for a completion signal that never comes. (#1294)
 */
export function isInteractiveMenuUnavailableNotice(message: string): boolean {
  return (
    message.includes("menu could not be shown in this session") ||
    message.includes("did not start:")
  );
}

export function isBlockedNoticeMessage(message: string): boolean {
  return (
    message.includes("blocked:") ||
    (isPauseNotice(message) && !isNonBlockingPauseNotice(message)) ||
    isManualResolutionNotice(message) ||
    isInteractiveMenuUnavailableNotice(message)
  );
}
