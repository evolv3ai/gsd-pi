# Plan 032a — Dead Code & Unused-Dependency Audit (W2)

**Branch:** `chore/lean-mean-cleanup`
**Date:** 2026-06-02
**Method:** `npx knip@latest --no-progress` (leads only) + manual verification of every
candidate with ripgrep over `src/`, `packages/`, `scripts/`, `tests/`, `web/`,
`studio/`, `integrations/` (excluding `node_modules`, `dist`, `dist-test`, `.git`),
plus `git log -S` / `git ls-files` for provenance, and a scripted existence check of
every path referenced from `package.json` scripts.

**Confidence tiers:** HIGH = safe to remove now · MEDIUM = needs a human glance ·
LOW/LEAD = do not remove (recorded so wave 2 doesn't re-litigate).

---

## 1. Unused dependencies (root package.json)

Legend: **USED** = imported from root-owned code (`src/`, `scripts/`, `tests/`,
`integrations/`) · **USED (workspace)** = imported only inside `packages/*`, which
declare the same dep in their own `package.json` (root entry is a duplicate) ·
**USED-VIA-SCRIPT** = invoked as a CLI binary in package.json scripts ·
**USED-VIA-PACKAGING** = deliberately added as bundled transitive packaging deps ·
**SUSPECT-UNUSED** = no reference found anywhere.

### 1a. USED from root code (24) — keep

| Dep | Example reference |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | dynamic `import()` + `require.resolve` in `src/resources/extensions/claude-code-cli/stream-adapter.ts:2503,:440` |
| `@clack/prompts` | `await import('@clack/prompts')` `src/onboarding.ts:128` |
| `@google/genai` | `await import("@google/genai")` `src/resources/extensions/google-search/index.ts:65` (also pi-ai, self-declared) |
| `@mariozechner/jiti` | `src/headless-query.ts:17`, `src/headless-recover.ts:19`, `src/worktree-cli.ts:23` |
| `@modelcontextprotocol/sdk` | `src/mcp-server.ts:55`, `src/tests/package-mcp-server-elicitation.test.ts:3` |
| `@opengsd/gsd-browser` | `requireFromResourceLoader.resolve('@opengsd/gsd-browser/SKILL.md')` `src/resource-loader.ts:200`; `src/update-check.ts:13` |
| `@sinclair/typebox` | `src/resources/extensions/browser-tools/tools/*.ts` (~20 files), `src/tests/mcp-client-schema.test.ts:3` |
| `ajv` | `await import("ajv")` `src/resources/extensions/browser-tools/tools/extract.ts:190`; `src/resources/extensions/gsd/tests/single-writer-v3-tool-surface.test.ts:21` |
| `chalk` | `src/cli.ts:15`, `src/welcome-screen.ts:15`, `src/worktree-cli*.ts` |
| `extract-zip` | `src/rtk.ts:9`; `scripts/install/deps.js:114` (published installer) |
| `minimatch` | `src/resources/extensions/gsd/bootstrap/write-gate.ts:5`; asserted importable post-install by `scripts/validate-pack.js:685` |
| `picomatch` | `_require("picomatch")` `src/resources/extensions/ttsr/ttsr-manager.ts:18`, `src/resources/extensions/gsd/safety/file-change-validator.ts:22` |
| `playwright` | `await import("playwright")` `src/resources/extensions/browser-tools/lifecycle.ts:182`; integration tests |
| `proper-lockfile` | `src/resources/extensions/gsd/file-lock.ts:2`, `session-lock.ts:306`, `commands-extensions.ts:18` |
| `sharp` | `await import("sharp")` `src/resources/extensions/browser-tools/screenshot-constraints.ts:42`, `tools/zoom.ts:56`, `tools/visual-diff.ts:110` |
| `strip-ansi` | `src/welcome-screen.ts:16` |
| `undici` | `await import('undici')` `src/loader.ts:178` |
| `ws` | `src/web/cloud-transport.ts:1` (also self-declared by cloud-mcp-gateway/daemon/gsd-cloud) |
| `yaml` | `src/tests/resource-loader.test.ts:7`, `src/tests/ci-builder-image-config.test.ts:9`, `scripts/__tests__/*.test.mjs`; asserted by `validate-pack.js:685` |
| `zod` | not imported by root `src/` directly, but a required peer of `@modelcontextprotocol/sdk` which `src/mcp-server.ts` loads (lockfile ties zod versions to the MCP SDK). Keep. |

### 1b. USED only inside `packages/*` (which self-declare them) — root entry is a duplicate (21) — LOW removal confidence

Each of these is imported exclusively from `packages/pi-ai`, `packages/pi-coding-agent`,
`packages/pi-tui`, `packages/daemon`, or `packages/pi-agent-core`, and every consuming
package lists the dep in its own `package.json` (verified against
`packages/*/package.json`). Zero imports from `src/`, `scripts/`, `tests/`:
`@anthropic-ai/sdk`, `@anthropic-ai/vertex-sdk`, `@aws-sdk/client-bedrock-runtime`,
`@mistralai/mistralai`, `@silvia-odwyer/photon-node`, `@smithy/node-http-handler`,
`cross-spawn`, `diff`, `discord.js`, `get-east-asian-width`, `glob`, `highlight.js`,
`hosted-git-info`, `http-proxy-agent`, `https-proxy-agent`, `ignore`, `marked`,
`openai`, `partial-json`, `sql.js`, `typebox`.

- Example evidence: `@anthropic-ai/sdk` → only `packages/pi-ai/src/providers/anthropic.ts:1`, `packages/daemon/src/orchestrator-agent.ts:1` (both self-declare it).
- **Why not flagged for removal:** the published tarball ships `packages/*/dist` +
  manifests, and `scripts/validate-pack.js` runs a real npm global-install smoke test
  whose hoisting behavior may depend on root-level copies (see 1d). Extension code is
  jiti-loaded from the installed root and resolves externals against root
  `node_modules`. Wave 2 may drop these only after `pnpm run validate-pack` passes
  without them. **Tier: LOW/LEAD (do not remove in wave 2 without validate-pack evidence).**

### 1c. USED-VIA-SCRIPT / build tooling (devDependencies) — keep

| Dep | Evidence |
|---|---|
| `c8` | binary in `test:coverage`, `test:coverage:unit`, `test:coverage:integration` |
| `cross-env` | binary in `build:web-host`, `test:coverage*` |
| `typescript` | `tsc` in `build:core`, `typecheck:extensions`; `tsconfig*.json` |
| `esbuild` | `import { build } from "esbuild"` in `scripts/__tests__/validate-pack.test.mjs:7`, `packages/pi-tui/src/tests/*.test.ts`, `packages/pi-coding-agent/src/tests/*.test.ts` |
| `jiti` | `require("jiti")` in `src/resources/extensions/browser-tools/tests/*.test.{cjs,mjs}` (4 files) |
| `@types/node` | `"types": ["node"]` in every `packages/*/tsconfig.json`; implicit for root TS |
| `@types/proper-lockfile` | types for `proper-lockfile` imported at `src/resources/extensions/gsd/file-lock.ts:2` (package ships no own types) |

### 1d. USED-VIA-PACKAGING — deliberate, do not remove casually (5) — MEDIUM

`balanced-match`, `brace-expansion`, `graceful-fs`, `retry`, `signal-exit` have **zero
imports anywhere** in the repo, but `git log -S` shows they were added intentionally in
commit `7faba933b` *"fix: make validate-pack pass with pnpm workspace protocol — Add
bundled transitive packaging deps … so npm global-install smoke tests work after the
pnpm migration"*. They are runtime transitives of `proper-lockfile` / `glob` /
`minimatch` that the compiled vendored dist `require()`s when npm installs the
published tarball flat. **Tier: MEDIUM** — removal is plausibly safe under pnpm but
must be re-verified with `pnpm run validate-pack` (npm flat-install path).

### 1e. SUSPECT-UNUSED (4) — MEDIUM

| Dep | What was checked |
|---|---|
| `chokidar` (`dependencies`) | Zero import/require in any source, script, test, or config (only a regex string in `bg-shell/process-manager.ts:122` matching CLI names). Not in pi-coding-agent's shrinkwrap packaging list. Present since Initial Commit — likely inherited from upstream pi where the TUI watched files. Removal risk: low, but re-run build+validate-pack. |
| `proxy-agent` (`dependencies`) | Zero usage. `packages/pi-ai/src/utils/node-http-proxy.ts:3-4` imports `http-proxy-agent` + `https-proxy-agent` directly; `src/loader.ts:178` uses undici's `EnvHttpProxyAgent`. |
| `file-type` (`dependencies` **and** `packages/pi-coding-agent/package.json:43`) | Zero usage in root and zero inside pi-coding-agent (no `file-type` import, no `fileTypeFromBuffer` anywhere). Image handling now goes through `@silvia-odwyer/photon-node` (`packages/pi-coding-agent/src/utils/photon.ts`) and the native engine. Declared in two manifests, imported in none. |
| `ajv-formats` (`devDependencies`) | Zero usage; no `addFormats` call anywhere. Tests use plain `ajv` / `ajv/dist/2020.js`. |

Also weak-suspect: `@types/picomatch` (devDep) — picomatch is only consumed via
`_require()` with locally declared `PicomatchFn` types (`ttsr-manager.ts`,
`file-change-validator.ts`); no static TS import of `picomatch` exists, so the types
package is never exercised. **Tier: MEDIUM** (harmless; auto-included by tsc).

### 1f. knip corroboration

`knip` independently flagged as unused at root: all 21 entries of 1b, all 5 of 1d, and
`chokidar`, `file-type`, `proxy-agent`, `ajv-formats` — matching the manual analysis
exactly. knip additionally flags `web/` radix/shadcn deps and some `packages/*` devDeps
(`canvas`, `@types/diff`, `@types/ms`, `shx`, `@xterm/xterm`) — **out of W2 root scope,
recorded as LEADS only.**

---

## 2. Dead source files

### 2a. HIGH confidence — safe to remove (6)

| File | Evidence |
|---|---|
| `src/resources/extensions/gsd/roadmap-mutations.ts` (134 L) | All 4 exports (`markSliceDoneInRoadmap`, `markSliceUndoneInRoadmap`, `markTaskDoneInPlan`, `markTaskUndoneInPlan`) have **zero** references repo-wide (path-stem, plain-string, and per-symbol searches all empty, tests included). Only in Initial Commit; header says it was extracted from doctor/mechanical-completion/auto-recovery, but those call sites no longer import it. |
| `src/resources/extensions/gsd/commands-bootstrap.ts` (283 L) | Sole export `registerLazyGSDCommand` has zero references; filename string `commands-bootstrap` appears nowhere. `/gsd` command registration lives elsewhere (`commands.ts` / `commands/handlers/`). |
| `src/resources/extensions/gsd/triage-ui.ts` (196 L) | `showTriageConfirmation` / `ConfirmedTriage` unreferenced; the only repo mention is a comment in `tests/triage-resolution.test.ts:12` explaining why the test does **not** import it. |
| `src/resources/extensions/gsd/tests/resolve-ts-hooks.mjs` | Zero references. The live loader used by ~20 package.json scripts and scripts/*.mjs is the sibling `resolve-ts.mjs` (verified by searching all `resolve-ts` references — none name `-hooks`). |
| `src/tests/integration/web-mode-runtime-fixtures.ts` | Zero path/symbol references (`makeRuntimeWorkspaceFixture`, `seedInterruptedRunRecoverySessions`, etc. all unused). The live helper is the sibling `web-mode-runtime-harness.ts`, imported by `web-mode-onboarding.test.ts:18`. |
| `src/rtk-shared.js` | **The only tracked stale compiled artifact in `src/`** (committed in Initial Commit) sitting next to source `src/rtk-shared.ts`. `.gitignore` (`src/**/*.js`) covers it, yet it is force-tracked. Under `node --experimental-strip-types` a `.js` sibling on disk shadows the `.ts` source, so this file is an active stale-code hazard, not just clutter. |

### 2b. MEDIUM confidence — human glance before removing (4)

| File / dir | Evidence |
|---|---|
| `src/resources/extensions/gsd/tests/integration/headless-command.ts` | Unreferenced; docstring says it is a manual `npx tsx …` debug harness. Delete or keep as a dev tool — owner's call. |
| `packages/gsd-agent-core/scripts/generate-session-decomposition.mjs` | Zero references (not in any package.json, CI, or doc). One-off codegen script. |
| `packages/pi-ai/scripts/generate-test-image.ts` | Zero references; manual test-image generator utility. |
| `studio/` (whole Electron app) | Not listed in `pnpm-workspace.yaml`, not referenced by root scripts, CI, or release workflows; only docs mentions (`docs/dev/FILE-SYSTEM-MAP.md`, ADR-013, provider docs). knip flags all its entry files. It is a self-contained app with its own package.json — likely an orphaned experiment, but removing a product surface is a human decision. |

### 2c. LOW/LEAD — do not remove (knip false positives explained)

knip reported 328 "unused files"; the overwhelming majority are live:

- **`src/resources/extensions/*/index.ts` and tool files** (async-jobs, aws-auth,
  bg-shell, browser-tools ~25 files, context7, github-sync, google-cli, mac-tools,
  universal-config, voice, slash-commands): extension entry points are discovered and
  jiti-loaded **by directory name at runtime** (`src/extension-discovery.ts`,
  `scripts/copy-resources.cjs` copies `src/resources` into the shipped package). All
  were re-verified to have inbound references or registry/discovery coverage. **Not dead.**
- **`src/resources/skills/create-gsd-extension/templates/*.ts`**: templates copied and
  read as text by the create-extension skill. **Not dead.**
- **`src/resources/extensions/gsd/tests/fixtures/*worker.ts`**: spawned as worker
  processes by tests. **Not dead.**
- **`packages/pi-coding-agent/examples/**` (80+ files)**: documentation/example code
  shipped as docs. **Not dead.**
- **`web/components/ui/*.tsx`** (~40 shadcn components) and `web/hooks/use-*.ts`: knip
  flags many as unreferenced within `web/`; they are a vendored component library.
  Pruning is possible but is a web-surface decision — **LEAD only**, out of wave-2 scope.
- **`vscode-extension/`** source flagged by knip (entry via VS Code manifest, not
  imports) — separate product, **not dead**.
- **`tests/live/run.ts`, `tests/live-regression/benchmark.ts`**: referenced by
  package.json scripts (`test:live`, `test:live-regression`). **Not dead.**

### 2d. The `.js`/`.d.ts`-next-to-`.ts` pattern — mostly a local-disk hazard, not committed

Contrary to the initial suspicion, committed stale artifacts are **not widespread**:
`git ls-files src | grep -E '\.(js|d\.ts)$'` returns exactly two files —
`src/rtk-shared.js` (stale, see 2a) and `src/types/opengsd-mcp-server.d.ts` (a legit
hand-written declaration file, no `.ts` sibling). No tracked `.js` with `.ts` sibling
exists under `packages/*/src` either.

However, the working tree currently holds **157 untracked non-test `.js` + 73 untracked
`.d.ts` files inside `src/`** (gitignored tsc output, e.g.
`src/resources/extensions/gsd/atomic-write.js`). Two operational notes for the cleanup
branch, not wave-2 deletions:

1. `scripts/copy-resources.cjs` already skips `.js` files that have a `.ts`/`.tsx`
   sibling (comment: "Skip stale compiled siblings"), so packaging is safe.
2. Scripts that run sources directly via `node --experimental-strip-types`
   (`baseline:*`, `test:integration`, etc.) will prefer a stale on-disk `.js` over the
   `.ts` source. Recommend a documented `git clean -ndX src` review step for devs, or
   deleting local `.js`/`.d.ts` in `src/` before running strip-types tests.

---

## 3. Orphaned package.json scripts

**None found.** All 103 root scripts were machine-checked: every referenced
`scripts/`, `tests/`, `src/`, `native/` path (including `--import` loaders and
`--test-reporter` paths) exists; every glob (e.g. `src/tests/integration/*.test.ts`,
`tests/e2e/**/*.e2e.test.ts`) matches at least one file. Every path in the `files`
field (`scripts/postinstall.js`, `scripts/install.js`, `scripts/install`,
`scripts/link-workspace-packages.cjs`, `scripts/lib/workspace-manifest.cjs`,
`scripts/lib/logo.cjs`, `integrations/hermes/plugin.yaml`) exists. Scripts that merely
*look* old (baselines, audits, one-off gates) were deliberately **not** flagged — that
classification belongs to W3 (scripts/ archival).

---

## 4. Duplicate implementations (high-confidence only)

| Tier | Finding | Evidence |
|---|---|---|
| HIGH | `packages/rpc-client/src/jsonl.ts` ≡ `packages/gsd-agent-modes/src/modes/rpc/jsonl.ts` — **byte-identical** (`diff` empty; both export `attachJsonlLineReader`). Consolidate to one import. | `diff` of the two files |
| HIGH | `src/rtk-shared.ts` vs `src/resources/extensions/shared/rtk-shared.ts` — near-identical modules (`getManagedRtkDir` etc.); the `src/` copy adds only `prependPathEntry`/`applyRtkProcessEnv`/`buildRtkEnv`. Two sources of truth for RTK env logic. | `diff` of the two files |
| MEDIUM | `packages/gsd-cloud/src/cloud-config.ts` vs `packages/daemon/src/cloud-config.ts` — near-duplicate; diverged only in `saveCloudConfig` (legacy `device_token` stripping + `projectDirs` handling in the gsd-cloud copy). | `diff` (≈20 changed lines) |
| MEDIUM | `findMilestoneIds` / `extractMilestoneSeq` implemented 3× with different behavior: `src/resources/extensions/gsd/milestone-id-utils.ts`, `…/gsd/milestone-ids.ts`, `packages/mcp-server/src/readers/paths.ts`. Same name, different semantics — a bug magnet, but each has live callers. | per-symbol grep + `diff` |
| LOW | Parallel architectural copies that are intentional layering, **do not merge in this pass**: `packages/pi-agent-core/src/harness/compaction/*` ↔ `packages/gsd-agent-core/src/compaction/*` (same function names, ~1000 diff lines); `pi-agent-core/harness/messages.ts` ↔ `pi-coding-agent/core/messages.ts` (67 diff lines); `getClaudeCommand`/`buildClaudeSpawnInvocation` ×3 (`src/claude-cli-check.ts`, `src/resources/shared/claude-runtime-floor.ts`, `src/resources/extensions/claude-code-cli/readiness.ts`); `fuzzyFindText` in `packages/native/src/diff/index.ts` ↔ `pi-coding-agent/.../edit-diff.ts` (native Rust-bound port). | name-scan + `diff` |

---

## 5. Summary counts

| Category | HIGH | MEDIUM | LOW/LEAD |
|---|---|---|---|
| Dependencies (root) | 0 | 4 suspect-unused (chokidar, proxy-agent, file-type, ajv-formats) + 5 packaging deps + `@types/picomatch` | 21 root-duplicate entries (validate-pack-gated) |
| Dead files | 6 | 4 (incl. `studio/` as a whole) | ~320 knip leads dispositioned as false positives / out-of-scope |
| Orphaned scripts | 0 | 0 | 0 (103/103 resolve) |
| Duplicate implementations | 2 | 2 | 4 families (intentional layering) |

## 6. Recommended wave-2 order

1. Delete the 6 HIGH files (2a) and run `pnpm run typecheck:extensions` + the gsd
   extension unit tests (`test:unit:compiled` subset) — no feature surface touched.
2. Consolidate the two HIGH duplicates (single `jsonl.ts`, single `rtk-shared.ts`).
3. Drop `chokidar`, `proxy-agent`, `ajv-formats` (+ `file-type` from **both**
   manifests, + optionally `@types/picomatch`); verify `pnpm run build:core`,
   `typecheck:extensions`, and `node scripts/validate-pack.js`.
4. Only then, optionally, evaluate the 5 packaging deps (1d) and 21 root duplicates
   (1b) behind a full `validate-pack` run.
5. MEDIUM items (headless-command harness, two generator scripts, `studio/`) go to the
   owner for a keep/delete decision; W3 owns scripts/ classification.
