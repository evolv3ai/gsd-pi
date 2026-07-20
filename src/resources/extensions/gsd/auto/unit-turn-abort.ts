// Project/App: gsd-pi
// File Purpose: Best-effort auto-mode unit turn cancellation.

import type { ExtensionContext } from "@gsd/pi-coding-agent";

type AbortableContext = Pick<ExtensionContext, "abort"> | { abort?: unknown };

export function abortActiveUnitTurn(ctx: AbortableContext | null | undefined): boolean {
  const abort = ctx && typeof ctx.abort === "function" ? ctx.abort : null;
  if (!abort) return false;

  try {
    abort.call(ctx);
    return true;
  } catch {
    return false;
  }
}
