// Project/App: gsd-pi
// File Purpose: Browser Automation Contract — the single source for the canonical
// Pi-facing browser tool vocabulary. Engine adapters (legacy Playwright, managed
// gsd-browser), UAT policy, dispatch preflight, and evidence detection all derive
// their browser tool knowledge from this module instead of re-listing names.

/**
 * Canonical `browser_*` tool names of the Browser Automation Contract.
 *
 * These are the product-level names Units see regardless of which Browser
 * Automation Engine serves them (ADR-024). Adding a capability here is the
 * one-line vocabulary change; the engine adapters and presentation surfaces
 * are typed against this list, so missing coverage fails typecheck.
 */
export const BROWSER_CONTRACT_TOOL_NAMES = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_click_ref",
  "browser_fill_ref",
  "browser_wait_for",
  "browser_assert",
  "browser_verify",
  "browser_screenshot",
  "browser_snapshot_refs",
  "browser_find",
  "browser_get_console_logs",
  "browser_get_network_logs",
  "browser_evaluate",
  "browser_reload",
  "browser_batch",
  "browser_act",
] as const;

export type BrowserContractToolName = (typeof BROWSER_CONTRACT_TOOL_NAMES)[number];

const BROWSER_CONTRACT_TOOL_NAME_SET: ReadonlySet<string> = new Set(BROWSER_CONTRACT_TOOL_NAMES);

export function isBrowserContractToolName(name: string): name is BrowserContractToolName {
  return BROWSER_CONTRACT_TOOL_NAME_SET.has(name);
}

/**
 * Whether a canonical (non-MCP-prefixed) tool name belongs to the browser tool
 * family. Broader than the contract list on purpose: an External MCP Client or
 * host integration may supply additional `browser_*` tools that still satisfy
 * browser-backed UAT.
 */
export function hasBrowserContractPrefix(canonicalToolName: string): boolean {
  return canonicalToolName.startsWith("browser_");
}

/**
 * Contract tool names whose appearance in prose marks browser-backed UAT
 * activity (requirement or evidence language). Consumed by the
 * browser-evidence regexes so textual detection stays derived from the
 * contract vocabulary.
 */
export const BROWSER_EVIDENCE_SIGNAL_TOOL_NAMES = [
  "browser_assert",
  "browser_batch",
  "browser_find",
  "browser_verify",
  "browser_snapshot_refs",
] as const satisfies readonly BrowserContractToolName[];
