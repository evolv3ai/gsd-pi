# M004/S04 Transactional Import Application Research

Status: completed implementation boundary for M004/S04
Scope: Import Application contract and implementation completed through T07

## Decision

GSD exposes one explicit `applyLegacyImport` boundary. A fresh call consumes an unchanged sealed Preview, the Preview creation input, and one independently verified backup. It recaptures the current database base rather than accepting caller-selected revision fences. One `import.apply` Domain Operation owns every canonical mutation, the immutable Application receipt, one bounded audit event, outbox delivery, projection work, and the single project revision increment. Authority Epoch does not change in S04.

T01 intentionally added no Application executor. It froze the public contract and recorded the unsafe baseline that T02-T05 closed.

## Research method

Three independent tracks inspected the production schema and transaction kernel, the 26-case public legacy corpus and semantic adapters, and the recovery/restart/contention boundary. They converged on the same ownership flow:

1. public Application orchestrator;
2. pure whole-Preview compiler;
3. strict context-bound row writer;
4. existing Domain Operation transaction;
5. immutable Application row plus bounded event as the replay aggregate.

The existing destructive restore writer is not an Application seam. It owns broad replacement transactions and compatibility cleanup; extending it would create a second authority path.

## Pre-implementation executable gaps

The following gaps describe the T01 baseline. T02-T05 closed them in the
completed Application boundary.

### Generic `import.apply` could commit without an Application

At the T01 baseline, `executeDomainOperation` accepted any nonblank operation type. A generic `import.apply` operation with ordinary event and projection output committed, advanced revision, and left no `workflow_import_applications` row. The Application table triggers validated a row when one was inserted; they did not require every import operation to create one.

T02 reserved `import.apply` for a typed import-only executor and requires exactly one matching Application row before the authority compare-and-swap.

### Generic request hashing cannot satisfy receipt causality

The Application trigger requires:

```text
workflow_operations.request_hash = workflow_import_applications.preview_hash
```

The generic Domain Operation hashes the complete request envelope: operation type, revision and epoch fences, actor and transport provenance, tracing, payload, and epoch behavior. Even when the payload is the exact Preview envelope, that whole-request hash is not the Preview hash. A real receipt insert therefore aborts through the production causality trigger.

The narrow resolution is an import-only executor which records the already validated Preview hash. The generic executor and its hashing remain unchanged. There is no caller-supplied hash, hash strategy, operation registry, or relaxed trigger.

### Structural Preview validation is not semantic Application authorization

Preview validation proves exact JSON shape, hashes, ordering, counts, and evidence relationships. Its target validator deliberately accepts any nonblank kind, key, and optional field. A cryptographically valid Preview can therefore contain a target that Application cannot write.

T03 compiles the entire Preview through the one explicit target adapter allowlist before a write transaction begins. Zero unresolved diagnoses is necessary but not sufficient; the Preview must also be compiler-valid.

### Preview hash is not the complete replay identity

Two verified backups can share one Preview hash while differing in backup bytes, size, reference, verification time, or other metadata. Changed bytes or size produce a new `backup_id`; relocation or verification-time changes can retain the same `backup_id` while the complete artifacts still differ. Invocation provenance can also differ while the Preview remains identical. The schema-required operation request hash must still be the Preview hash, so exact replay needs a separate versioned Application identity.

The durable replay aggregate combines:

- normalized invocation provenance, retaining idempotency key, actor, transport, trace, and turn;
- a canonical identity for the Preview creation input;
- Preview ID and hash;
- the complete verified-backup object, not only `backup_id`;
- the immutable Application row;
- the bounded `legacy-import.applied` event for facts not present in the row.

Replay identity schema 1 has one executable canonical tuple. Invocation optionals become `null`; source roots pass the existing root validator and sort by root ID; bundled definition names use exact text, sort, deduplicate, and treat absence as an empty array. `previewInputHash` is the canonical legacy-import hash of that normalized Preview input. The replay tuple then contains its schema version, normalized invocation, `previewInputHash`, Preview ID/hash, and the complete verified-backup object. `applicationIdentityHash` is the canonical legacy-import hash of that complete replay tuple. Neither hash replaces the schema-required operation `request_hash = preview_hash`.

Replay checks durable rows before consulting source or backup files. An exact retry must remain possible after those ephemeral files disappear. If lookup by idempotency key and lookup by unique Preview identity find incompatible durable facts, Application fails with a typed replay conflict rather than choosing one.

## Public contract

The v1 input contains only:

- `invocation` — transport and idempotency identity;
- `previewInput` — explicit source roots plus optional bundled definition names used to recreate the Preview;
- `preview` — the sealed read-only artifact the user approved;
- `backup` — the verified backup prepared for that Preview and base.

The caller does not provide an operation type, request hash, project revision, Authority Epoch, approval boolean, unresolved override, force flag, restore choice, or cutover control. Calling the separate Application boundary is the authorization. Fresh execution captures the current base internally and compares it with both the Preview and backup.

The compact result contains committed or replayed status, operation and project identity, the separate Application identity hash, Preview and backup identities, base and resulting revision/epoch, application time, and event/outbox/projection receipt identities. It does not duplicate raw legacy content.

T01 rejects non-finite, cyclic, accessor-backed, symbol-bearing, sparse, or non-plain nested request data before cloning; it then detaches and deeply freezes the replay identity and safe error context. The input and receipt interfaces define shape; T05 detaches and freezes the complete public request and persisted result at the execution boundary. This is an in-memory guarantee only; fresh execution must still revalidate referenced files and database authority.

## Failure contract

Stable stages are:

- `contract`
- `replay`
- `preview`
- `backup`
- `compile`
- `coordination`
- `transaction`
- `receipt`

Stable codes distinguish invalid contract, replay conflict, invalid/changed/unresolved Preview, invalid/changed backup, unsupported or inconsistent mapping, active coordination, stale authority, writer contention, mutation failure, and inconsistent receipt. Retryability is explicit per error so wrapped Preview and backup failures preserve their actual semantics.

Error context is limited to safe hashes, IDs, counts, and cause codes. Raw legacy values and secret-bearing paths do not belong in errors or the bounded audit event. Error context is detached and deeply frozen.

## Corpus findings

The sealed public v1 corpus currently has 12 Application-eligible cases and 14 cases that must refuse before any Domain Operation:

Eligible:

- `custom-workflow`
- `gsd-nested`
- `jsonl-history`
- `knowledge-graph`
- `planning-flat-complete`
- `planning-multi-milestone-completed-range`
- `planning-multi-milestone-details`
- `planning-multi-milestone-emoji-range`
- `planning-multi-milestone-heading`
- `planning-multi-milestone-summary`
- `root-external-boundaries`
- `synthetic-smoke`

Refused:

- `action-matrix`
- `assessment-matrix`
- `composite-capstone`
- `db-target-matrix`
- `gsd-alias-hybrid`
- `gsd-flat`
- `lifecycle-truth-matrix`
- `planning-loss-surfaces`
- `planning-milestone-dirs`
- `planning-multi-milestone`
- `planning-number-aliases`
- `registries`
- `registries-lowercase`
- `worktree-topology`

This split is an executable corpus-v1 expectation, not a permanent product quota. A case is eligible only when its sealed Preview has zero unresolved dispositions, remains unchanged, has a matching verified backup and current base, and compiles completely through supported deterministic mappings.

## Semantic application rules

- Compile and account for every source, diagnosis, resolution, and change before writing.
- Merge compatible whole-row and field changes targeting the same canonical row. `planning-flat-complete` proves sequential naïve inserts are wrong.
- Order creates milestone → slice → task → subordinate records → lifecycle adoption. `gsd-nested` proves Preview order is not dependency order.
- Delete only complete row sets, in reverse dependency order.
- Require exactly one affected row for updates and deletes.
- Never use permissive `INSERT OR IGNORE`, `REPLACE`, or compatibility upserts.
- Adopt explicit lifecycle shadow state without fabricating attempts, results, transitions, waivers, or settlement history.
- Reject assessment mutation unless path, content, authority, and identity are deterministic.
- Preserve raw values, locators, parser/source identity, diagnoses, and resolutions in the immutable Preview stored by the Application receipt.
- Preserve-only and unparsed-but-resolved material may produce no canonical row mutation, but the Application receipt is still the durable disposition.
- Never execute legacy JSONL events, workflow definitions, workflow runs, graph snapshots, worktree instructions, or other preserved material as authority.

## Coordination and atomicity

Fresh Application performs expensive source and backup verification outside the writer lock, then enters one `BEGIN IMMEDIATE` Domain Operation. Inside that transaction it rechecks authority and refuses genuinely active incompatible coordination:

- active workers;
- held milestone leases;
- claimed or running unit dispatches;
- claimed or running workflow execution attempts.

The Application path does not guess that active ownership is stale or silently clear it. Existing repair and reconciliation must terminalize abandoned ownership. The in-transaction check prevents another coordination writer from entering between the check and canonical mutation.

Every precommit failure rolls back the operation, canonical changes, receipt, event, outbox, projection work, and authority update. A process death after commit but before response is recovered by exact replay of the durable receipt. S04 increments project revision exactly once and leaves Authority Epoch unchanged.

## Explicit exclusions

S04 does not implement:

- live database replacement or restore;
- restore eligibility after Application;
- cutover;
- Authority Epoch advancement;
- Forward Repair;
- implicit import during startup, database open, derive, dispatch, or reconciliation;
- a second receipt or backup table;
- generic request-hash customization;
- caller bypasses or test callback injection in public handlers.

Those restore and epoch boundaries are owned by S05. The full quantitative ingress audit remains in S06.

## Test obligations

T01 characterized all four baseline gaps through real behavior, never source-text assertions. Later tasks updated the temporary unsafe-behavior expectations as the boundary closed.

The final S04 proof includes:

- real schema triggers and the real Domain Operation transaction;
- Test Writer RED, GREEN, and sabotage evidence;
- pure compiler action and ordering fixtures;
- strict writer affected-row proof;
- independent backup reopen and revalidation;
- exact replay with changed-input conflict;
- multi-process contention;
- subprocess death before commit and after commit-before-response;
- zero residue at every precommit fault point;
- all 26 public corpus cases with 12 commits and 14 no-write refusals;
- extension typechecking and retained Preview/backup/recover regressions.

## Implementation sequence

1. T02 reserved `import.apply` and added the typed Preview-hash Domain Operation path. (Completed.)
2. T03 built the pure whole-Preview compiler. (Completed.)
3. T04 added strict context-bound canonical writers. (Completed.)
4. T05 composed public preflight, durable receipt/event identity, and replay. (Completed.)
5. T06 proved fault, crash, restart, and contention behavior. (Completed.)
6. T07 sealed the public corpus and compatibility recovery capstone. (Completed.)

M004/S04 is complete through T07; no implementation task remains planned in
this slice.
