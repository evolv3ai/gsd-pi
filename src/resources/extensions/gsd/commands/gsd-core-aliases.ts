// Project/App: gsd-pi
// File Purpose: Alias redirects for namespace-grouping commands (ns-*).
//
// The ns-* names were command-grouping menus in an earlier CLI; gsd-pi uses a flat
// `/gsd help`, so these redirect there. Every other additional command is implemented
// natively as an adapted workflow in commands-gsd-core.ts.

export interface GsdCoreAliasRedirect {
  kind: "redirect";
  /** gsd-pi command (and args) to re-dispatch through the main dispatcher. */
  target: string;
  /** Short note shown to the user before re-dispatch. */
  note?: string;
}

export interface GsdCoreAliasUnavailable {
  kind: "unavailable";
  /** One-line description of what the command did previously. */
  legacy: string;
  /** Suggested gsd-pi alternative(s), if any. */
  alternative?: string;
}

export type GsdCoreAlias = GsdCoreAliasRedirect | GsdCoreAliasUnavailable;

/**
 * Namespace-grouping aliases (ns-*). Each redirects to the flat /gsd help.
 */
export const GSD_CORE_ALIASES: ReadonlyMap<string, GsdCoreAlias> = new Map<string, GsdCoreAlias>([
  ["ns-context", { kind: "redirect", target: "help", note: "Namespace command — use /gsd help to browse all commands." }],
  ["ns-ideate", { kind: "redirect", target: "help", note: "Namespace command — use /gsd help to browse all commands." }],
  ["ns-manage", { kind: "redirect", target: "help", note: "Namespace command — use /gsd help to browse all commands." }],
  ["ns-project", { kind: "redirect", target: "help", note: "Namespace command — use /gsd help to browse all commands." }],
  ["ns-review", { kind: "redirect", target: "help", note: "Namespace command — use /gsd help to browse all commands." }],
  ["ns-workflow", { kind: "redirect", target: "help", note: "Namespace command — use /gsd help to browse all commands." }],
]);

/**
 * Catalog entries (for autocomplete) derived from the alias table.
 * Surfaced as top-level subcommands so users discover them while typing.
 */
export const GSD_CORE_ALIAS_CATALOG: ReadonlyArray<{ cmd: string; desc: string }> = [
  { cmd: "ns-context", desc: "Alias for /gsd help" },
  { cmd: "ns-ideate", desc: "Alias for /gsd help" },
  { cmd: "ns-manage", desc: "Alias for /gsd help" },
  { cmd: "ns-project", desc: "Alias for /gsd help" },
  { cmd: "ns-review", desc: "Alias for /gsd help" },
  { cmd: "ns-workflow", desc: "Alias for /gsd help" },
];

/**
 * Tries to resolve a `/gsd <cmd> [args]` string against the namespace alias table.
 * Returns the matched alias (and remaining args) or null if no alias matches.
 */
export function matchGsdCoreAlias(trimmed: string): { alias: GsdCoreAlias; cmd: string; rest: string } | null {
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).trim();
  if (!cmd) return null;
  const alias = GSD_CORE_ALIASES.get(cmd);
  if (!alias) return null;
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  return { alias, cmd, rest };
}
