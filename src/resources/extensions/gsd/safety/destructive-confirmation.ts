/**
 * One-shot confirmation token for destructive bash commands.
 *
 * The destructive-command guard hard-blocks classified commands (force push,
 * rm -rf, SQL drop, etc.) in all modes. The block instructs the model to
 * confirm via ask_user_questions and re-issue the command. This module is the
 * missing escape hatch: it records the user's confirmation and lets the exact
 * confirmed command through exactly once.
 *
 * Design constraints:
 *  - In-memory only, never persisted. A confirmation token written to disk
 *    could silently auto-approve a destructive command in a later session —
 *    confirmation must be re-obtained every process lifetime.
 *  - One-shot. Consuming a token clears it, so a second destructive command
 *    (even an identical one) re-blocks and re-prompts.
 *  - Command-bound. The token only matches the exact (normalized) command
 *    string the user confirmed. A reworded command re-blocks, which is safe.
 *  - Per basePath, so concurrent workspaces in one process never share tokens.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { resolve } from "node:path";

/**
 * Question-id substring that marks an ask_user_questions call as a
 * destructive-command confirmation. The tool_result handler promotes the
 * pending command to a confirmed token when an affirmative answer arrives for
 * a question whose id contains this marker.
 */
export const DESTRUCTIVE_CONFIRM_GATE_MARKER = "destructive_confirm";

interface DestructiveConfirmationState {
  /** Command awaiting confirmation, captured when the guard blocked it. */
  pendingCommand: string | null;
  /** Confirmed command cleared on first matching consume. */
  confirmedCommand: string | null;
}

const statesByBasePath = new Map<string, DestructiveConfirmationState>();

function stateKey(basePath: string): string {
  return resolve(basePath);
}

function getState(basePath: string): DestructiveConfirmationState {
  const key = stateKey(basePath);
  let state = statesByBasePath.get(key);
  if (!state) {
    state = { pendingCommand: null, confirmedCommand: null };
    statesByBasePath.set(key, state);
  }
  return state;
}

/**
 * Normalize a command for stable matching across block → confirm → retry.
 * Trims surrounding whitespace and collapses internal runs of whitespace so
 * cosmetic reformatting of the same command still matches the token.
 */
export function normalizeDestructiveCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/**
 * Whether an ask_user_questions question id is a destructive-confirm gate.
 */
export function isDestructiveConfirmGateId(questionId: unknown): boolean {
  return typeof questionId === "string" && questionId.includes(DESTRUCTIVE_CONFIRM_GATE_MARKER);
}

/**
 * Record that a destructive command was blocked and is awaiting confirmation.
 * Called by the guard at block time. Overwrites any prior pending command —
 * only the most recently blocked command can be confirmed.
 */
export function requestDestructiveConfirmation(
  command: string,
  basePath: string = process.cwd(),
): void {
  const state = getState(basePath);
  state.pendingCommand = normalizeDestructiveCommand(command);
  // A fresh request invalidates any stale confirmed token for a different
  // command so confirmation cannot leak across distinct destructive actions.
  state.confirmedCommand = null;
}

/**
 * Promote the pending command to a confirmed, one-shot token. Called by the
 * tool_result handler when the user gives an affirmative answer to a
 * destructive-confirm gate. Returns the confirmed command, or null if there
 * was nothing pending (e.g. confirmation arrived without a preceding block).
 */
export function confirmDestructiveCommand(
  basePath: string = process.cwd(),
): string | null {
  const state = getState(basePath);
  if (!state.pendingCommand) return null;
  state.confirmedCommand = state.pendingCommand;
  state.pendingCommand = null;
  return state.confirmedCommand;
}

/**
 * Check whether the given command has been confirmed, consuming the token if
 * so. Returns true exactly once per confirmation; subsequent calls (or a
 * non-matching command) return false. Called by the guard before blocking.
 */
export function consumeDestructiveConfirmation(
  command: string,
  basePath: string = process.cwd(),
): boolean {
  const state = getState(basePath);
  if (!state.confirmedCommand) return false;
  if (state.confirmedCommand !== normalizeDestructiveCommand(command)) return false;
  state.confirmedCommand = null;
  return true;
}

/**
 * Inspect the pending command without consuming it (diagnostics/tests).
 */
export function peekPendingDestructiveCommand(
  basePath: string = process.cwd(),
): string | null {
  return getState(basePath).pendingCommand;
}

/**
 * Clear all destructive-confirmation state for a basePath (tests / flow reset).
 */
export function resetDestructiveConfirmation(basePath: string = process.cwd()): void {
  statesByBasePath.delete(stateKey(basePath));
}
