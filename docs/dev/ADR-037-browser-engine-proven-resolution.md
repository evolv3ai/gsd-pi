# ADR-037: Proven Engine Resolution — gsd-browser Primary for Browser-Facing Projects

**Status:** Accepted (supersedes the default-engine decision of ADR-024)
**Date:** 2026-06-10
**Related:** `docs/dev/ADR-024-gsd-browser-primary-browser-engine.md`, `CONTEXT.md`

## Context

ADR-024 froze legacy Playwright as the default Browser Automation Engine
because making managed `gsd-browser` the default introduced startup and
availability failures that blocked browser verification with nowhere to go.
ADR-024 also stated the engine choice "should be an explicit runtime decision"
— but the implementation was a static env-var default with no probe and no
fallback, which is exactly why a managed-engine startup failure was terminal.

The product direction is now to use `gsd-browser` for all browser-based apps.
gsd-browser ships as a bundled dependency (`@opengsd/gsd-browser`) and offers a
much richer automation surface than the 18-tool canonical contract exposes
(goal-driven runs, test generation, visual diff, recording, debug bundles).

## Decision

Engine selection deepens into **Browser Engine Resolution**
(`browser-tools/engine/selection.ts`), a runtime decision with a recorded
reason:

1. **Explicit override wins.** `GSD_BROWSER_ENGINE=gsd-browser|legacy|off`
   (aliases preserved: `playwright` → `legacy`) is honored verbatim, with no
   probe and no fallback — matching prior opt-in behavior.
2. **Browser-facing projects prefer gsd-browser when provable.** With no
   override, a project that `detectWebApp` classifies as browser-facing
   resolves to the managed engine only when the availability probe
   (`resolveGsdBrowserCliAvailability` in `shared/gsd-browser-cli.ts`) proves a
   CLI exists: explicit env config, the bundled `@opengsd/gsd-browser` binary,
   or a PATH binary.
3. **Probe-resolved selections are verified before commitment.** At session
   start, a probe-resolved managed engine must connect its daemon
   (`warmUpManagedGsdBrowser`, bounded by a 10s abort) before browser tools are
   registered against it. Connect failure falls back to legacy Playwright for
   the session with a user-visible notice, and the outcome is committed back
   into the resolution record (`commitBrowserEngineResolution`) so ambient
   readers — UAT guidance, re-warm-up, later sessions in the same process —
   see the engine actually registered, not the prediction. This is the
   fail-closed-with-fallback answer to ADR-024's blocker: a managed startup
   failure now degrades instead of blocking browser verification. When eager
   warm-up is disabled (`GSD_BROWSER_WARMUP=0`) the connect proof cannot run, so
   the probe default resolves to legacy Playwright rather than registering an
   unverified managed engine; forcing the managed engine without the proof
   stays an explicit `GSD_BROWSER_ENGINE=gsd-browser` opt-in.
4. **Non-browser-facing projects keep legacy Playwright.** Browser tools are
   incidental there; the managed daemon is not worth its startup risk. The
   resolution record says so explicitly.

Everything else in ADR-024 stands: the product contract remains the canonical
`browser_*` names (now declared once in `shared/browser-contract.ts`), MCP-
shaped names remain an External MCP Client concern, `/gsd mcp init` semantics
and `GSD_BROWSER_MCP_ENABLED` are unchanged, and evidence stays artifact-first.

## Consequences

- Browser-based UAT on web-app projects runs through gsd-browser by default,
  with zero prompt or policy changes (the contract names are engine-stable).
- "Which engine and why" is answerable from one typed resolution record
  (engine, source, reason) instead of an env var plus tribal knowledge.
- The resolution is table-driven testable without launching a browser
  (`tests/browser-engine-selection.test.mjs`).
- A broken gsd-browser install degrades to Playwright with a recorded reason
  instead of failing UAT dispatch.
- The ambient resolution is cached per project root for process life; the
  existing registered-engine guard still prevents mid-process engine switches.

## Alternatives Considered

### Keep Playwright default, document gsd-browser opt-in better

Rejected. The stated direction is gsd-browser for all browser-based apps, and
the opt-in env var leaves the richer engine unused exactly where it matters.

### Default gsd-browser everywhere (including non-web-app projects)

Rejected for now. Non-browser-facing projects rarely exercise browser tools;
paying daemon startup risk there buys nothing. Revisit if the daemon's
reliability record makes the probe redundant.

### Fall back at first tool call instead of session start

Rejected. Tools cannot be re-registered mid-session, so by first call the
engine commitment is already made; a session-start connect gate is the last
moment a clean fallback is possible.
