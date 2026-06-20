# ADR-024: Keep Playwright as the Default Browser Automation Engine

**Status:** Superseded in part by ADR-037 (the default-engine decision: browser-facing projects now prefer gsd-browser via proven resolution). The Browser Automation Contract boundary, MCP naming, and `/gsd mcp init` decisions remain in force.
**Date:** 2026-06-03
**Updated:** 2026-06-10
**Related:** `CONTEXT.md`, `docs/dev/ADR-008-gsd-tools-over-mcp-for-provider-parity.md`, `docs/dev/ADR-020-cloud-mcp-gateway-local-runtime.md`, `docs/dev/ADR-037-browser-engine-proven-resolution.md`

## Context

GSD has two browser automation paths. Pi Providers receive direct `browser_*`
tools from the bundled `browser-tools` extension, while Claude Code and other
External MCP Clients can receive `mcp__gsd-browser__browser_*` tools from
`gsd-browser mcp`.

The managed `gsd-browser` path gives GSD a richer browser automation surface,
but making it the default introduced startup and availability failures in places
where the existing Playwright-backed browser tools still worked. The product
contract agents see should stay stable as canonical `browser_*` tools; the
engine choice behind those tools should be an explicit runtime decision.

## Decision

Playwright is the default Browser Automation Engine for Pi Providers. The
existing `browser-tools` extension remains the Pi-facing Browser Automation
Contract adapter and continues to register canonical `browser_*` tools such as
`browser_navigate`, `browser_snapshot_refs`, and `browser_assert`.

`gsd-browser` remains available for External MCP Clients through `/gsd mcp init`
and as an explicit managed-engine opt-in for Pi Providers via
`GSD_BROWSER_ENGINE=gsd-browser`. MCP-shaped names such as
`mcp__gsd-browser__browser_navigate` remain an External MCP Client concern and a
Claude Code host concern.

The explicit engine selector is `GSD_BROWSER_ENGINE=gsd-browser|legacy|off`.
With no environment override, GSD uses the Playwright-backed `legacy` engine.
`GSD_BROWSER_ENGINE=playwright` is accepted as an alias for `legacy`, and `off`
disables Pi's Browser Automation Contract tools except for browser tools
supplied directly by an External MCP Client or host integration.

Project `.mcp.json` generation remains for External MCP Clients through
`/gsd mcp init`; it is not required for Pi Providers to use browser automation.
`GSD_BROWSER_MCP_ENABLED=0` disables only the browser entry in generated
external MCP config. It does not control Pi's built-in browser tools.

Browser evidence is artifact-first and image-optional. Tools such as
`browser_screenshot` should save evidence to artifact paths and return
text/structured metadata that every Provider can consume. Assertions, snapshots,
console/network logs, and evidence refs remain the primary verification surface.

## Consequences

- GSD keeps one product-level Browser Automation Contract based on canonical
  `browser_*` names.
- Pi Providers use Playwright by default, avoiding managed `gsd-browser` startup
  failures unless the operator explicitly opts into that engine.
- `/gsd mcp init` remains useful for MCP-capable hosts outside Pi or host
  integrations that expose MCP names directly.
- The managed `gsd-browser` engine can continue to evolve without blocking the
  default browser verification path.
- Engine selection stays separate from External MCP Client config generation.

## Migration Order

1. Keep the managed `gsd-browser mcp` engine manager under `browser-tools`.
2. Default `resolveBrowserEngineMode()` to `legacy` while preserving explicit
   `gsd-browser`, `playwright`, and `off` modes.
3. Keep debug, run-uat, and other browser-required flows using canonical
   `browser_*` tools so the prompt contract does not leak engine details.
4. Update `/gsd mcp init` copy, docs, and prompts so users understand that
   `.mcp.json` is for External MCP Clients while Pi Providers use built-in
   browser tools.

## Alternatives Considered

### Make `gsd-browser` the default

Rejected for now. It provides richer capabilities, but current managed-engine
startup failures can block browser verification even when Playwright succeeds.

### Expose MCP-shaped names to all Providers

Rejected. It would leak transport naming into Pi prompts and tool policy,
undoing the Browser Automation Contract boundary.

### Remove the managed `gsd-browser` path

Rejected. External MCP Clients still need it, and Pi Providers may opt into it
when the managed engine is appropriate for their environment.
