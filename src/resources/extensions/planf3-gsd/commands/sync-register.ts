import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runSync, type SyncOutcomeKind } from "./sync.js";
import { friendlyError } from "./error-message.js";
import { emit } from "../gsd/notify.js";

export interface SyncArgs { htmlPath: string | null; dryRun: boolean }

/** Quoting rule (same as preflight): argv is paths and flags ONLY. */
export function parseSyncArgs(args: string): SyncArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  return {
    htmlPath: tokens.find((t) => !t.startsWith("--")) ?? null,
    dryRun: tokens.includes("--dry-run"),
  };
}

export function severityFor(kind: SyncOutcomeKind): "info" | "warning" | "error" | "success" {
  switch (kind) {
    case "synced": return "success";
    case "aborted": return "error";
    case "not-located": return "error";
    default: return "info"; // no-change, dry-run, not-observable — all exit-0-style
  }
}

export function registerSyncCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-sync", {
    description: "Pull GSD runtime state back into the Planf3 HTML plan (status markers + bridge metadata).",
    async handler(args, ctx) {
      const parsed = parseSyncArgs(args);
      try {
        const outcome = await runSync(parsed.htmlPath, parsed.dryRun, { cwd: ctx.cwd });
        emit(ctx, outcome.message, severityFor(outcome.kind));
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
}
