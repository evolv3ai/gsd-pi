import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { friendlyError } from "../commands/error-message.js";
import { runPreflight, signOffPreflight, type PreflightDeps } from "../preflight/run.js";
import type { OrchestratorFacts } from "../preflight/types.js";

const FactsSchema = Type.Object({
  host: Type.String(),
  model: Type.String(),
  authMode: Type.String(),
  skills: Type.Array(Type.String()),
});

export function registerPreflightTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "planf3_gsd_preflight",
    label: "Planf3 GSD preflight",
    description: "Build the pipeline stage map (providers/auth/models per stage), run live auth probes, report drift vs specs/PRESETS.md, and record sign-off. Structured data rides these JSON params — never command argv.",
    promptSnippet: "Run the planf3-gsd preflight and show the workflow map.",
    promptGuidelines: [
      "Pass orchestratorFacts (your host, model, authMode, loaded skills) so the orchestrator stage is filled.",
      "Set signOff: true ONLY after the human explicitly approved the rendered map (approve / approve-with-note / abort).",
    ],
    parameters: Type.Object({
      htmlPath: Type.Optional(Type.String()),
      orchestratorFacts: Type.Optional(FactsSchema),
      signOff: Type.Optional(Type.Boolean()),
      note: Type.Optional(Type.String()),
      offline: Type.Optional(Type.Boolean()),
      ping: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const deps: PreflightDeps = {
          projectRoot: ctx.cwd,
          htmlPath: params.htmlPath ?? null,
          offline: params.offline === true,
          ping: params.ping === true,
          catalog: { ids: () => ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`) },
          orchestrator: (params.orchestratorFacts as OrchestratorFacts | undefined) ?? null,
        };
        if (params.signOff === true) {
          const { path, approvalHash } = await signOffPreflight(deps, params.note ?? null);
          return {
            content: [{ type: "text" as const, text: `Signed off. Record: ${path}\napprovalHash: ${approvalHash}` }],
            details: { recordPath: path, approvalHash },
          };
        }
        const run = await runPreflight(deps);
        return {
          content: [{ type: "text" as const, text: run.rendered }],
          details: { verdict: run.verdict, drift: run.drift, map: run.map },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: friendlyError(err) }],
          isError: true,
          details: { verdict: "error" as const, error: friendlyError(err) },
        };
      }
    },
  });
}
