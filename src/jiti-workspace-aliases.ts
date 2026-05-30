import { join } from "node:path";
import { resolvePackageRoot } from "./bundled-resource-path.js";

/** jiti alias map for @gsd/* workspace packages (CJS require cannot load ESM file:// URLs). */
export function getJitiWorkspaceAliases(importUrl: string): Record<string, string> {
  const root = resolvePackageRoot(importUrl);
  const pkg = (dir: string, ...segments: string[]) => join(root, "packages", dir, "src", ...segments);

  const piAi = pkg("pi-ai", "index.ts");
  const piAiOauth = pkg("pi-ai", "utils", "oauth", "index.ts");
  const piAgentCore = pkg("pi-agent-core", "index.ts");
  const piTui = pkg("pi-tui", "index.ts");
  const piCodingAgent = pkg("pi-coding-agent", "index.ts");
  const native = pkg("native", "index.ts");

  const aliases: Record<string, string> = {
    "@gsd/pi-ai": piAi,
    "@gsd/pi-ai/oauth": piAiOauth,
    "@gsd/pi-agent-core": piAgentCore,
    "@gsd/pi-tui": piTui,
    "@gsd/pi-coding-agent": piCodingAgent,
    "@gsd/native": native,
    "@earendil-works/pi-ai": piAi,
    "@earendil-works/pi-ai/oauth": piAiOauth,
    "@earendil-works/pi-agent-core": piAgentCore,
    "@earendil-works/pi-tui": piTui,
    "@earendil-works/pi-coding-agent": piCodingAgent,
  };

  return aliases;
}
