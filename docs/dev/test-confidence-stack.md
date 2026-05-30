# Test confidence stack

This document maps **what protects what** across local scripts and CI. Use it when you need merge confidence, not just a green `verify:pr`.

## Quick reference

| When | Run locally | CI equivalent | Blocks merge? |
|------|-------------|---------------|---------------|
| Every push | `npm run verify:fast` | `fast-gates` | Yes |
| Fast iteration while editing | `npm run verify:pr` | Partial (`build:core` + `test-unit` only) | No — not sufficient alone |
| **Before requesting PR review** | **`npm run verify:merge`** | `build`, `test-unit`, `test-packages`, `integration-tests`, `e2e` | Yes (when `heavy-code-changed`) |
| Full evaluation baseline | `npm run test:evaluation` | Partial (blocking tiers + auxiliary) | No |
| Repo-wide coverage report | `npm run test:coverage:full` | `coverage-report` job on PRs | Report-only on PRs |

**Node 26+:** `c8` depends on `yargs` v17, which breaks under Node 26’s module resolution. The repo pins `yargs@^18` via `package.json` `overrides` (CI uses Node 24).
| After merge to main/dev/test | — | `test-coverage` | Yes on main pipeline |
| Docker paths changed | `npm run test:e2e:docker` | `docker-e2e` | Yes when triggered |
| Portability paths changed | Windows job + package tests | `windows-portability` | Yes when triggered |
| Windows smoke (experimental) | `npm run test:e2e:windows-smoke` | `windows-smoke-e2e` | **Warn only** (`continue-on-error`) |

Run the inventory anytime:

```bash
npm run audit:test-confidence
npm run audit:test-confidence -- --strict   # fail if tier map drifts from package.json
npm run audit:test-gaps                     # unwired tests, zero-test extensions, thin packages
npm run audit:test-gaps -- --strict-unwired # fail if any test file is unreachable
npm run audit:test-matrix                   # per-source-file status matrix
npm run audit:test-matrix -- --strict       # fail if P0 extensions remain untested
npm run audit:test-matrix -- --write-report # regenerate docs/dev/test-evaluation-report.md
```

## Test runners by code area

| Code area | Test runner | Invoked by | Notes |
|-----------|-------------|------------|-------|
| `src/` + GSD extension | `node --test` on compiled `dist-test/` | `test:unit` | Primary app unit tests; compile via `test:compile` |
| Extension integration suites | `node --test` + `resolve-ts.mjs` | `test:integration` | ollama, async-jobs, browser-tools, search-the-web, bg-shell, slash-commands |
| `packages/*` | `node --test` (compiled to dist-test) | `test:packages` | Every linkable package must have ≥1 test (`verify:workspace-coverage`) |
| Extensions with ≥5 source files | `tests/*.test.*` required | `verify:extension-coverage` | Enforced in `verify:merge` |
| `scripts/__tests__` | `node --test` | `verify:fast` | CI contract/policy regressions |
| `tests/e2e/` | `node --test` against built binary | `test:e2e` | Requires `GSD_SMOKE_BINARY=dist/loader.js` |
| Coverage (merged) | c8 across unit/integration/packages | `test:coverage:full` | Writes `coverage/lcov.info` + `coverage/file-index.json` |
| Coverage thresholds | c8 on GSD slice | `test:coverage` | **main/dev/test push** only |

## Enforcement philosophy

### Block merge (PR)

When `heavy-code-changed=true`, CI runs the full stack in parallel after a single build artifact:

1. `build` — compile, web host, `validate-pack`, workspace coverage gate
2. `test-unit` — compiled unit tests
3. `test-packages` — workspace package tests
4. `integration-tests` — integration globs (includes ollama + new extension tests)
5. `e2e` — smoke binary tests
6. `coverage-report` — merged coverage artifacts (report-only, does not block)

Local parity: **`npm run verify:merge`** (runs the same npm scripts sequentially, including `verify:extension-coverage`).

`verify:fast` also runs:

- `scripts/__tests__/`
- `audit:test-gaps --strict-unwired`
- `audit:test-matrix --strict`

### Block main (post-merge)

- `test:coverage` — c8 thresholds (40/40/20/20) on the GSD slice
- Release pipeline smoke / live regression — see [CI/CD Pipeline Guide](./ci-cd-pipeline.md)

### Warn or path-gate

- **Windows e2e smoke** — runs when Windows-relevant paths change but does not block merge today
- **Docker e2e** — required when docker paths change, skipped otherwise
- **Doc-only PRs** — skip build/test jobs intentionally; `fast-gates` still runs

## Why `verify:pr` still exists

`verify:pr` is a **fast inner loop** (~5–15 min): `build:core` → `typecheck:extensions` → `test:unit`.

It is intentionally lighter than CI. Do not treat a passing `verify:pr` as merge-ready. Use `verify:merge` before requesting review.

`verify:full` is an alias for `verify:merge` (kept for backward compatibility).

## Known gaps (honest)

These are tracked limitations, not bugs to hide:

1. **Web UI** — few unit tests; use `audit:test-matrix` to track file-level gaps
2. **Windows smoke** — non-blocking until flake rate is acceptable
3. **Single-file extensions** — may still lack dedicated tests (below extension gate threshold)

## Related docs

- [Test evaluation report](./test-evaluation-report.md) — regeneratable matrix snapshot
- [CI/CD Pipeline Guide](./ci-cd-pipeline.md) — promotion pipeline and workflow files
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — local development commands
