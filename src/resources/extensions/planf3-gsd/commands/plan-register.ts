/**
 * Registration layer for /planf3-gsd-plan and /planf3-gsd-run: tokenize
 * args, run the pure logic in plan.ts, inject the prompt via
 * pi.sendUserMessage, emit confirmations/errors. Fire-and-forget by
 * design — never polls or awaits the injected turn.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { runPlan, type BuildChainFlags } from "./plan.js";
import { friendlyError } from "./error-message.js";
import { emit } from "../gsd/notify.js";

export interface ParsedRequestArgs {
  request: string;
  flags: Set<string>;
}

/** Strip recognized `--flag` tokens from the raw args string wherever they
 *  appear, preserving the request's internal spacing. Quotes are the
 *  shell/UI's concern and pass through verbatim. */
export function parseRequestArgs(args: string, recognized: readonly string[]): ParsedRequestArgs {
  const flags = new Set<string>();
  let request = args;
  for (const flag of recognized) {
    // (?=\s|$) keeps "--step" from matching inside "--step-unsafe".
    const re = new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`, "g");
    const next = request.replace(re, "");
    if (next !== request) {
      flags.add(flag);
      request = next;
    }
  }
  return { request: request.trim(), flags };
}

export interface PlanCommandDeps {
  /** Injectable for tests; defaults to process.cwd(). */
  cwd?: string;
  /** Injectable for tests; defaults to os.homedir() inside discovery. */
  homeDir?: string;
}

const PLAN_USAGE = 'Usage: /planf3-gsd-plan "<request>" [--questionable]';
const PLAN_FLAGS = ["--questionable"] as const;

export function registerPlanCommand(pi: ExtensionAPI, deps: PlanCommandDeps = {}): void {
  pi.registerCommand("planf3-gsd-plan", {
    description: "Plan with planf3, then export the HTML plan to a GSD spec + manifest (no milestone).",
    async handler(args, ctx) {
      try {
        const { request, flags } = parseRequestArgs(args, PLAN_FLAGS);
        if (!request) {
          emit(ctx, PLAN_USAGE, "error");
          return;
        }
        const outcome = await runPlan({
          cwd: deps.cwd ?? process.cwd(),
          ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
          request,
          questionable: flags.has("--questionable"),
          chain: { target: "export" },
        });
        if (!outcome.ok) {
          emit(ctx, outcome.guidance, "error");
          return;
        }
        pi.sendUserMessage(outcome.prompt, { deliverAs: "followUp" });
        emit(
          ctx,
          `Queued a planf3 planning turn (skill: ${outcome.skillPath}).\nchain=planf3_gsd_export → specs/<name>.gsd.md + <name>.manifest.json, no milestone.\nFire-and-forget: watch the agent's reply, or /planf3-gsd-status.`,
          "info",
        );
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
}

const RUN_USAGE = 'Usage: /planf3-gsd-run "<request>" [--step] [--questionable] [--no-prefs] [--force] [--step-unsafe]';
const RUN_FLAGS = ["--questionable", "--step", "--no-prefs", "--force", "--step-unsafe"] as const;

export function registerRunCommand(pi: ExtensionAPI, deps: PlanCommandDeps = {}): void {
  pi.registerCommand("planf3-gsd-run", {
    description: "End-to-end: plan with planf3, export, create the GSD milestone, and start GSD.",
    async handler(args, ctx) {
      try {
        const { request, flags } = parseRequestArgs(args, RUN_FLAGS);
        if (!request) {
          emit(ctx, RUN_USAGE, "error");
          return;
        }
        const buildFlags: BuildChainFlags = {
          auto: !flags.has("--step"),
          applyPrefs: !flags.has("--no-prefs"),
          force: flags.has("--force"),
          allowUnsafeStep: flags.has("--step-unsafe"),
        };
        const outcome = await runPlan({
          cwd: deps.cwd ?? process.cwd(),
          ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
          request,
          questionable: flags.has("--questionable"),
          chain: { target: "build", flags: buildFlags },
        });
        if (!outcome.ok) {
          emit(ctx, outcome.guidance, "error");
          return;
        }
        pi.sendUserMessage(outcome.prompt, { deliverAs: "followUp" });
        emit(
          ctx,
          `Queued a planf3 plan+build turn (skill: ${outcome.skillPath}).\nchain=planf3_gsd_build auto=${buildFlags.auto} applyPrefs=${buildFlags.applyPrefs} force=${buildFlags.force} allowUnsafeStep=${buildFlags.allowUnsafeStep}\nFire-and-forget: watch the agent's reply, /planf3-gsd-status, and .gsd/planf3-gsd-evals.jsonl.`,
          "info",
        );
      } catch (err) {
        emit(ctx, friendlyError(err), "error");
      }
    },
  });
}
