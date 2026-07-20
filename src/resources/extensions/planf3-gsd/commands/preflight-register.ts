import { resolve } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { emit } from "../gsd/notify.js";
import { friendlyError } from "./error-message.js";
import { runPreflight, signOffPreflight } from "../preflight/run.js";
import { issueApprovalToken } from "../preflight/approval-token.js";
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

export interface PreflightArgs {
  htmlPath: string | null;
  offline: boolean;
  ping: boolean;
  check: boolean;
  asJson: boolean;
  /** null = normal run; "" = --sign-off given without a value (refused downstream). */
  signOffToken: string | null;
}

/** Quoting rule (spec §6.1): argv is paths and flags ONLY. `--sign-off`
 *  consumes the following token as its value. */
export function parsePreflightArgs(args: string): PreflightArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let htmlPath: string | null = null;
  let signOffToken: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--sign-off") {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        signOffToken = next;
        i++;
      } else {
        signOffToken = "";
      }
    } else if (!t.startsWith("--") && htmlPath === null) {
      htmlPath = t;
    }
  }
  return {
    htmlPath,
    offline: tokens.includes("--offline"),
    ping: tokens.includes("--ping"),
    check: tokens.includes("--check"),
    asJson: tokens.includes("--json"),
    signOffToken,
  };
}

/** Insert the token line ABOVE the trailing `preflight: verdict=…` machine
 *  line. F6.0-6: the printed command carries the plan path exactly as the
 *  human typed it — a bare sign-off of a projected token is refused. */
export function withApprovalTokenLine(rendered: string, token: string, htmlPath: string | null): string {
  const invocation = htmlPath === null
    ? `/planf3-gsd-preflight --sign-off ${token}`
    : `/planf3-gsd-preflight ${htmlPath} --sign-off ${token}`;
  const line = `approval token: ${token} — to approve this map, the human runs: ${invocation}`;
  const lines = rendered.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (last.startsWith("preflight: verdict=")) {
    lines.splice(lines.length - 1, 0, line);
    return lines.join("\n");
  }
  return `${rendered.trimEnd()}\n${line}`;
}

export function registerPreflightCommand(pi: ExtensionAPI): void {
  pi.registerCommand("planf3-gsd-preflight", {
    description: "Map the pipeline's providers/auth/models, probe credentials, and report drift vs the signed-off PRESETS record.",
    async handler(args, ctx) {
      const parsed = parsePreflightArgs(args);
      const deps = {
        projectRoot: ctx.cwd,
        htmlPath: parsed.htmlPath,
        offline: parsed.offline,
        ping: parsed.ping,
        catalog: { ids: () => ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`) },
        orchestrator: piFacts(ctx),
      };
      try {
        if (parsed.signOffToken !== null) {
          const { path, approvalHash } = await signOffPreflight(deps, null, parsed.signOffToken);
          emit(ctx, `Signed off. Record: ${path}\napprovalHash: ${approvalHash}`, "success");
          if (parsed.check) process.exitCode = EXIT_CODES.ok;
          return;
        }
        const run = await runPreflight(deps);
        // F5.1-2: the console is the only surface that mints the human
        // approval token (the tool result never carries one). Inserted ABOVE
        // the trailing verdict line so the machine channel stays last.
        let rendered = run.rendered;
        if (run.verdict === "unapproved" || run.verdict === "drift") {
          const token = await issueApprovalToken(ctx.cwd, run.approvalHash, {
            projectedFrom: parsed.htmlPath !== null ? resolve(ctx.cwd, parsed.htmlPath) : null,
          });
          rendered = withApprovalTokenLine(rendered, token, parsed.htmlPath);
        }
        emit(ctx, parsed.asJson ? JSON.stringify({ verdict: run.verdict, drift: run.drift, map: run.map }, null, 2) + "\n" + `preflight: verdict=${run.verdict}` : rendered, run.verdict === "ok" ? "info" : "warning");
        if (parsed.check) process.exitCode = EXIT_CODES[run.verdict];
      } catch (err) {
        emit(ctx, `${friendlyError(err)}\npreflight: verdict=error`, "error");
        if (parsed.check) process.exitCode = EXIT_CODES.error;
      }
    },
  });
}
