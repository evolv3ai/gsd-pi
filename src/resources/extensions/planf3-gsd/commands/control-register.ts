import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runSteer, runPause, runResume, runStop, type ControlOutcome } from "./control.js";
import { friendlyError } from "./error-message.js";
import { emit } from "../gsd/notify.js";

/** Resume takes an optional plan path — same rule as sync: argv is paths only. */
export function parseResumeArgs(args: string): string | null {
  return args.trim().split(/\s+/).filter(Boolean).find((t) => !t.startsWith("--")) ?? null;
}

export function severityForControl(kind: ControlOutcome["kind"]): "info" | "error" {
  return kind === "ok" ? "info" : "error";
}

export function registerControlCommands(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-steer", {
    description: "Send one steering instruction into the running GSD headless build (eval-logged).",
    async handler(args, ctx) {
      try {
        const outcome = await runSteer(args, { cwd: ctx.cwd });
        emit(ctx, outcome.message, severityForControl(outcome.kind));
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
  pi.registerCommand("planf3-gsd-pause", {
    description: "Pause the running GSD headless build.",
    async handler(_args, ctx) {
      try {
        const outcome = await runPause({ cwd: ctx.cwd });
        emit(ctx, outcome.message, severityForControl(outcome.kind));
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
  pi.registerCommand("planf3-gsd-resume", {
    description: "Resume the paused GSD build: one bounded auto/next round per the manifest's mode.",
    async handler(args, ctx) {
      try {
        const outcome = await runResume(parseResumeArgs(args), { cwd: ctx.cwd });
        emit(ctx, outcome.message, severityForControl(outcome.kind));
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
  pi.registerCommand("planf3-gsd-stop", {
    description: "Stop the running GSD headless build (eval-logged).",
    async handler(_args, ctx) {
      try {
        const outcome = await runStop({ cwd: ctx.cwd });
        emit(ctx, outcome.message, severityForControl(outcome.kind));
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
}
