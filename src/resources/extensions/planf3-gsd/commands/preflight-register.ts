import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { emit } from "../gsd/notify.js";
import { friendlyError } from "./error-message.js";
import { runPreflight } from "../preflight/run.js";
import type { OrchestratorFacts, Verdict } from "../preflight/types.js";

/** Verdict → exit code (gsd-style contract, spec §6.1). NOTE: in `pi --print`
 *  the host clobbers this (src/cli.ts:778 process.exit(0) after runPrintMode);
 *  the guaranteed machine channel is the LAST stdout line `preflight: verdict=…`
 *  and the tool JSON. Kept because it costs nothing and works under hosts that
 *  exit naturally. */
export const EXIT_CODES: Record<Verdict, number> = { ok: 0, unapproved: 20, drift: 21, error: 1 };

function piFacts(ctx: { model?: { id: string; provider: string } | undefined; modelRegistry?: { getProviderAuthMode(provider: string): string } }): OrchestratorFacts | null {
  if (!ctx.model) return null;
  let authMode = "unknown";
  try {
    authMode = ctx.modelRegistry?.getProviderAuthMode(ctx.model.provider) ?? "unknown";
  } catch { /* registry may not resolve every provider */ }
  return { host: "pi", model: `${ctx.model.provider}/${ctx.model.id}`, authMode, skills: [] };
}

export function registerPreflightCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-preflight", {
    description: "Map the pipeline's providers/auth/models, probe credentials, and report drift vs the signed-off PRESETS record.",
    async handler(args, ctx) {
      // Quoting rule (spec §6.1): argv is paths and flags ONLY.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const htmlPath = tokens.find((t) => !t.startsWith("--")) ?? null;
      const offline = tokens.includes("--offline");
      const ping = tokens.includes("--ping");
      const check = tokens.includes("--check");
      const asJson = tokens.includes("--json");
      try {
        const run = await runPreflight({
          projectRoot: ctx.cwd,
          htmlPath,
          offline,
          ping,
          catalog: { ids: () => ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`) },
          orchestrator: piFacts(ctx),
        });
        emit(ctx, asJson ? JSON.stringify({ verdict: run.verdict, drift: run.drift, map: run.map }, null, 2) + "\n" + `preflight: verdict=${run.verdict}` : run.rendered, run.verdict === "ok" ? "info" : "warning");
        if (check) process.exitCode = EXIT_CODES[run.verdict];
      } catch (err) {
        emit(ctx, `${friendlyError(err)}\npreflight: verdict=error`, "error");
        if (check) process.exitCode = EXIT_CODES.error;
      }
    },
  });
}
