// Project/App: gsd-pi
// File Purpose: Handler that resolves namespace alias redirects (ns-*).
//
// Returns true (handled) when the input matches a namespace alias. Redirects
// re-dispatch through the main dispatcher so safety guards apply to the target
// command too. Unavailable aliases print a helpful message and stop.

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { matchGsdCoreAlias, type GsdCoreAlias } from "./gsd-core-aliases.js";

function formatUnavailable(cmd: string, alias: Extract<GsdCoreAlias, { kind: "unavailable" }>): string {
  const lines: string[] = [
    `/gsd ${cmd} is not available.`,
    `Previously it: ${alias.legacy}`,
  ];
  if (alias.alternative) lines.push(`Alternative: ${alias.alternative}`);
  lines.push("Run /gsd help for the command reference.");
  return lines.join("\n");
}

export async function handleGsdCoreAlias(
  trimmed: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<boolean> {
  const match = matchGsdCoreAlias(trimmed);
  if (!match) return false;

  const { alias, cmd, rest } = match;

  if (alias.kind === "unavailable") {
    ctx.ui.notify(formatUnavailable(cmd, alias), "warning");
    return true;
  }

  // Redirect: rebuild the target command with any trailing args, then re-dispatch
  // through the main dispatcher so guards + handlers run against the target.
  const targetWithArgs = rest ? `${alias.target} ${rest}` : alias.target;
  if (alias.note) {
    ctx.ui.notify(`${cmd} → /gsd ${alias.target} (${alias.note})`, "info");
  } else {
    ctx.ui.notify(`${cmd} → /gsd ${alias.target}`, "info");
  }
  const { handleGSDCommand } = await import("./dispatcher.js");
  await handleGSDCommand(targetWithArgs, ctx, pi);
  return true;
}
