# Plan 020: Add request timeouts to the cloud pairing/device-flow HTTP helper (both copies)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7cca07ae..HEAD -- packages/gsd-cloud/src/cloud-config.ts packages/daemon/src/cloud-config.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (test execution in CI depends on plan 018, but this plan is independently correct)
- **Category**: bug
- **Planned at**: commit `7cca07ae`, 2026-07-07

## Why this matters

`postJsonToValidatedGateway` — the HTTP POST helper used by cloud pairing
(`exchangePairingCode`) and the whole RFC 8628 device-flow (`runDeviceFlow`
awaits it for the code request and inside its token-poll loop) — registers only
`req.on("error", reject)`. There is no socket timeout and no AbortController.
If the gateway accepts the TCP connection but never responds (hung server,
half-open connection, blackhole), the promise never settles and
`gsd cloud pair` / `gsd-cloud login` hangs forever with a spinner. The helper
exists in two near-identical copies — `packages/gsd-cloud/src/cloud-config.ts`
and `packages/daemon/src/cloud-config.ts` — and both have the same gap. (This
duplicated-pair has drifted before in this repo's history; fix both in the same
change, identically.)

## Current state

Files and roles:

- `packages/gsd-cloud/src/cloud-config.ts` — gateway URL validation (SSRF guards) + `postJsonToValidatedGateway` at lines ~193–228. The request options include a custom `lookup: createGatewayLookup(url)`.
- `packages/daemon/src/cloud-config.ts` — the duplicate; same function, `req.on("error", reject)` at line ~225.
- `packages/gsd-cloud/src/device-flow.ts` — awaits the helper at lines ~43 (code request) and ~91 (token poll). Poll-loop network errors are caught-and-continued ("transient — keep trying until expiry"), so a per-request timeout integrates cleanly: a timed-out poll just retries.
- `packages/daemon/src/device-flow.test.ts` — existing loopback-HTTP-server test pattern for this code family.

`packages/gsd-cloud/src/cloud-config.ts:198–227` (verbatim, abridged tail):

```ts
export function postJsonToValidatedGateway(url: URL, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  validateGatewayNetworkTarget(url);
  const body = JSON.stringify(payload);
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: { /* content-type, content-length */ },
      lookup: createGatewayLookup(url),
    }, (res) => {
      /* buffers body, parses JSON, resolves/rejects on status */
    });

    req.on("error", reject);
    req.end(body);
  });
}
```

The daemon copy is structurally identical (confirm by diffing the two functions
before editing).

Conventions: these files use double quotes and semicolons; match them. Tests are
`node:test` + `assert/strict`, compiled to `dist/` and run by each package's
`test` script (see `packages/gsd-cloud/package.json`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| gsd-cloud tests | `pnpm --filter @opengsd/gsd-cloud run test` | exit 0, all pass |
| daemon build (deps) | `pnpm run build:core` (once, if daemon deps lack dist) | exit 0 |
| daemon tests | `pnpm --filter @opengsd/daemon run build && pnpm --filter @opengsd/daemon run test` | exit 0, all pass |

## Scope

**In scope**:

- `packages/gsd-cloud/src/cloud-config.ts`
- `packages/daemon/src/cloud-config.ts`
- `packages/gsd-cloud/src/cloud-config.test.ts` (create)
- `packages/daemon/src/cloud-config.test.ts` (exists — extend)
- The two package.json `test` scripts ONLY if a newly created test file must be added to the explicit file list (gsd-cloud lists test files explicitly; daemon lists `dist/cloud-config.test.js` already).

**Out of scope**:

- Deduplicating the two `cloud-config.ts` copies into a shared package — deliberate maintainer decision pending (gsd-cloud is designed dependency-free); keep the copies in sync instead.
- `device-flow.ts` in either package — the poll loop's catch-and-continue already handles a rejecting request correctly.
- The SSRF-guard functions (`parseCloudGatewayUrl`, `validateGatewayNetworkTarget`, `createGatewayLookup`) — tested separately under plan 022.

## Git workflow

- Branch: `advisor/020-cloud-pairing-http-timeouts`
- Conventional Commit, e.g. `fix(cloud): time out hung gateway requests in pairing and device flow`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the timeout to the gsd-cloud copy

In `packages/gsd-cloud/src/cloud-config.ts`, give the helper an optional timeout
parameter with a 30s default, and destroy the socket on expiry. Signature change:

```ts
const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;

export function postJsonToValidatedGateway(
  url: URL,
  payload: Record<string, unknown>,
  timeoutMs: number = GATEWAY_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
```

and immediately before `req.on("error", reject);` add:

```ts
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Gateway request timed out after ${timeoutMs}ms`));
    });
```

`req.destroy(err)` causes the `error` event, so the existing `reject` handler
fires — no double-settle (the Promise constructor ignores late rejections, and
the response `end` handler cannot fire after destroy).

**Verify**: `pnpm --filter @opengsd/gsd-cloud run build` → exit 0.

### Step 2: Mirror the identical change in the daemon copy

Apply the exact same edit (same constant name, same parameter, same
`setTimeout` block) to `packages/daemon/src/cloud-config.ts`. After editing,
confirm the two functions are textually identical:

**Verify**: extract both function bodies and diff, e.g.
`diff <(sed -n '/^export function postJsonToValidatedGateway/,/^}/p' packages/gsd-cloud/src/cloud-config.ts) <(sed -n '/^export function postJsonToValidatedGateway/,/^}/p' packages/daemon/src/cloud-config.ts)` → empty output.

### Step 3: Tests in both packages

Test shape (model on `packages/daemon/src/device-flow.test.ts`, which stands up
a loopback `node:http` server): create a server whose handler deliberately
never responds (`createServer(() => { /* never call res.end */ })`), call
`postJsonToValidatedGateway(new URL(baseUrl + "/x"), {}, 200)` with a 200ms
timeout, and assert it rejects with `/timed out after 200ms/` in well under the
default 30s. Add a second case asserting a normal fast response still resolves
(server responds `200` with `{}`). Note: the helper's SSRF guard allows plain
HTTP only for localhost — a `http://127.0.0.1:<port>` loopback server is the
valid test vector (this is exactly what the existing daemon device-flow tests
use).

- gsd-cloud: create `packages/gsd-cloud/src/cloud-config.test.ts`; then add `dist/cloud-config.test.js` to the explicit file list in the package's `test` script.
- daemon: add the same two cases to the existing `packages/daemon/src/cloud-config.test.ts` (already in the test script's file list).

**Verify**: `pnpm --filter @opengsd/gsd-cloud run test` → all pass including 2 new; `pnpm --filter @opengsd/daemon run build && pnpm --filter @opengsd/daemon run test` → all pass including 2 new.

## Test plan

Four new tests total (two per package): hung-server rejects with the timeout
error; healthy server resolves. Pattern files:
`packages/daemon/src/device-flow.test.ts` (loopback server harness),
`packages/gsd-cloud/src/cloud-gateway-lookup.test.ts` (assertion style).

## Done criteria

- [ ] `grep -c "setTimeout" packages/gsd-cloud/src/cloud-config.ts` ≥ 1 and same for the daemon copy
- [ ] The function-body diff in Step 2 is empty
- [ ] Both package test suites pass with the new cases
- [ ] `git status` clean outside in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- The two copies of `postJsonToValidatedGateway` have ALREADY diverged beyond the excerpt (more than cosmetic differences) — report the divergence; do not reconcile other differences.
- A timeout test is flaky twice in a row (timing-sensitive CI) — report rather than raising the test timeout above 5s.
- The fix appears to require touching `device-flow.ts`.

## Maintenance notes

- These two files are copy-synced by convention. Any future edit to one MUST be mirrored; reviewers should ask for the Step 2 diff check on every PR touching either.
- If gsd-cloud and daemon ever share a package, this helper is the first candidate to consolidate (recorded in `plans/README.md`).
- The 30s default matters for the device-flow poll loop: each poll already sleeps `pollIntervalMs` between requests, so a timed-out poll delays the next attempt by at most `timeout + interval` — no busy-loop risk.
