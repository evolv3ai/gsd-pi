// Project/App: gsd-pi
// File Purpose: Best-effort auto-mode unit turn cancellation.

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";

type AbortableContext =
  | Pick<ExtensionContext, "abort" | "isIdle">
  | { abort?: unknown; isIdle?: unknown };

export function abortActiveUnitTurn(ctx: AbortableContext | null | undefined): boolean {
  const abort = ctx && typeof ctx.abort === "function" ? ctx.abort : null;
  if (!abort) return false;

  // Mirror pauseAuto's `!ctx.isIdle()` guard (auto.ts): when the context can
  // report idleness and says it is idle, there is no active turn to abort, so
  // skip. This keeps cleanup callers (signal interrupt, crash close-out,
  // finalize retry) from accidentally aborting a future/idle turn. `isIdle` is
  // an opt-in, best-effort guard: when it is unavailable or throws, fall back
  // to the unconditional best-effort abort.
  const isIdle =
    ctx && typeof (ctx as { isIdle?: unknown }).isIdle === "function"
      ? (ctx as { isIdle: () => unknown }).isIdle
      : null;
  if (isIdle) {
    try {
      if (isIdle.call(ctx)) return false;
    } catch (err) {
      // Idleness could not be determined; fall through to best-effort abort.
      logWarning(
        "recovery",
        `abortActiveUnitTurn: isIdle() check failed, falling back to abort: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  try {
    abort.call(ctx);
    return true;
  } catch {
    return false;
  }
}
