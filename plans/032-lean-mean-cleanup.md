# Plan 032 — Lean & Mean Cleanup

**Branch:** `chore/lean-mean-cleanup` (from `origin/main` @ 8397230a7)
**Goal:** Remove dead code and shrink the footprint of gsd-pi without reducing any
user-facing capability. The CLI must still plan, implement, verify, and track work
exactly as before — every feature stays, dead weight goes.

## Guiding constraints (from AGENTS.md / VISION.md)

- Simplicity first; surgical changes; match codebase conventions.
- If behavior is removed, remove or update the tests that asserted it.
- No full-repo test suite on every tiny edit — run the smallest meaningful gate.
- Blast radius evaluated per workstream before touching anything.
- No AI credit in commits/PRs. No remote branch deletion without owner confirmation.

## Workstreams

### W1 — Lazy-load heavyweight dependencies (code change, verify with build)

`package.json` hard-deps `playwright`, `sharp`, `discord.js`,
`@silvia-odwyer/photon-node` — browser engines and image libraries loaded for a
CLI whose hot path (`gsd --version`, print mode, auto mode) never needs them.

- Map actual import sites for each heavy dep.
- Convert to lazy/dynamic imports at the point of use so startup never pays for
  them; keep them as dependencies so features still work when invoked.
- Acceptance: `pnpm run build:core` + `pnpm run typecheck:extensions` green;
  targeted tests for touched modules green; `gsd --version` / smoke unchanged.

### W2 — Dead code & unused-dependency audit (report first, remove in wave 2)

- Tooling-assisted scan (knip or equivalent) + manual confirmation of
  unused files, unused exports in `src/`, unused deps/devDeps, and orphaned
  scripts entries.
- Output: `plans/032a-dead-code-audit.md` with evidence per finding
  (why it is dead, what references were checked).
- Nothing deleted in wave 1. Wave 2 applies only high-confidence removals.

### W3 — scripts/ archival (code change, low risk)

117 entries in `scripts/`; many are completed one-off migration/baseline/audit
tools. Classify each script: (a) referenced by package.json/CI/docs → keep,
(b) unreferenced one-off → move to `scripts/archive/` with an index README.
No package.json command changes in this pass — only files nothing references move.

### W4 — Docs consolidation (PLAN ONLY this pass)

Four doc surfaces (`docs/`, `gitbook/`, `mintlify-docs/`, `docs/zh-CN/`).
Wholesale moves risk link rot across npm/GitHub/Discord. Deliverable this pass:
a consolidation recommendation section in the final report, no file moves.

### W5 — Branch hygiene (REPORT ONLY)

List stale local/remote branches with last-commit dates. No deletions without
explicit owner confirmation (remote deletion is irreversible and visible).

## Verification gate (integration, after swarm)

1. `pnpm run build:core`
2. `pnpm run typecheck:extensions`
3. `node --experimental-strip-types tests/smoke/run.ts`
4. Unit tests for any module touched (targeted, not full suite)
5. `gsd --version` + `gsd --help` smoke from `dist/loader.js`

## Explicitly out of scope

- No behavioral changes to the workflow engine, providers, or MCP surfaces.
- No dependency *removal* that breaks a feature when used (lazy-load ≠ remove).
- No gitbook/mintlify moves, no remote branch deletions, no PR creation
  (offered at the end for owner decision).
