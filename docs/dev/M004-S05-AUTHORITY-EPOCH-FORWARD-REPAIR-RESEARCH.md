# M004/S05 Authority Epoch and Forward Repair Research

Status: accepted implementation boundary for M004/S05
Scope: restore policy, cutover ownership, and Forward Repair contract; runtime implementation begins in T02

## Decision

GSD will have one narrow, irreversible authority boundary.

A verified pre-import backup may replace the live database only while the
corresponding Import Application is still the exact canonical head, no later
canonical operation has committed, Authority Epoch has not advanced, the
backup still verifies, coordination is quiet, and the user has given explicit
destructive Consent. Any later canonical write or cutover permanently closes
that restore window. Later row equality does not reopen it. Recovery must then
repair the current database forward and preserve accepted work.

This resolves the conflict between the accepted RFC and ADR-046 in favor of
the stricter RFC rule. ADR-046's former consent-and-difference-review exception
after later writes is removed. Consent authorizes an otherwise eligible
destructive restore; it never overrides stale authority, later work, cutover,
invalid evidence, or active coordination.

Authority Epoch advancement will no longer be a caller-selected option on the
generic Domain Operation request. One typed cutover operation will own it.
Import Application, live restore, ordinary workflow changes, and Forward
Repair retain the current epoch.

## Why this is the safe simple boundary

Database replacement erases history after the backup. Once another canonical
operation commits, determining whether it is safe to erase requires policy
about accepted work, not merely a byte or row comparison. Allowing a
difference review to override that fact would create two rollback policies,
make exact replay depend on interpretation, and let equal-looking rows hide
erased event and receipt history.

The strict rule is deterministic:

```text
Import Application is exact current head
  + backup verifies
  + same project/schema/revision/epoch/base
  + coordination is quiet
  + destructive Consent
      -> live restore may run once

anything committed after the Application, or any cutover
      -> live restore is forbidden forever
      -> compare backup base, Application result, and current state
      -> apply Forward Repair to current state
```

No force flag, administrator override, row-equality exception, down migration,
or Markdown-authority fallback exists.

## Research method

Independent tracks inspected:

1. the accepted RFC, ADR-046, `CONTEXT.md`, and S03/S04 research;
2. Authority Epoch schema, request hashing, compare-and-swap, and all production
   Domain Operation callers;
3. verified backup preparation, independent restore drill, database
   open/close/checkpoint seams, and interactive/headless recovery routes;
4. recovery and lifecycle-shadow repair tables to determine whether an
   existing aggregate could safely be reused; and
5. fault, restart, and multi-process tests around the closest boundaries.

The tracks converged on five missing production capabilities: a durable
cutover receipt, a read-only restore assessor, crash-safe live replacement, an
import-specific Forward Repair planner/writer, and recommendation-led routing.

## Current implementation map

### Authority Epoch is durable and its generic advancement is now closed

`project_authority.authority_epoch` is protected by the Domain Operation
compare-and-swap and copied into operations, events, outbox-related lineage,
Projection Work, lifecycle records, and import receipts. It never decreases in
the current writer.

T03 removed `advanceAuthorityEpoch` from the public request. Generic and Import
Application operations always retain the epoch, reject the retired runtime
property, and reserve `authority.cutover` for one typed aggregate. Ordinary
request hashes deliberately retain the former explicit `false` member so
already-committed operations replay byte-for-byte across the change.

The private advancing seam derives its receipt contract from the hashed
cutover payload. Its transaction refuses both commit and replay unless exactly
one immutable V45 cutover receipt matches the operation, result revision,
result epoch, time, contract, evidence, and Consent hashes. A structural test
limits that seam to the strict public cutover aggregate.

The public aggregate accepts only the exact V1 contract, current V45 schema,
explicit irreversible Consent, the exact current Import Application head, and
quiet coordination. Its evidence revalidates the canonical sealed Preview,
compiled plan, full production Application event receipt, operation and
Application causality, delivery lineage, invocation, backup facts, revision,
and epoch. The current schema cannot recompute the three hashes whose full
preimages were not persisted (`applicationIdentityHash`, `backupArtifactHash`,
and `backupId`); it therefore treats the exact immutable Application event as
their durable identity receipt and binds all three into the evidence hash.

### Verified backup and restore drill are strong but deliberately non-live

S03 prepares a content-addressed SQLite backup after strict checkpoint and
base/source stability checks. It independently verifies bytes, schema,
project identity, revision, epoch, relevant-row hash, integrity, foreign keys,
and representative queries.

`drillLegacyImportBackupRestore` copies the verified backup into a disposable
directory, flushes and publishes the staged copy there, verifies it in a fresh
process, and removes the directory. The test `restores distinct bytes, verifies
them in a fresh process, cleans state, and leaves live authority untouched`
proves exact live database bytes and lineage remain unchanged. This drill stays
non-destructive after S05; it is not renamed or expanded into live restore.

T04 shipped the missing assessor as the pure, read-only
`assessLegacyImportRestore` in `legacy-import-restore-assessment.ts`, and T05
shipped the single owner that atomically installs a backup over the active
project database in `legacy-import-live-restore.ts`.

### Recovery routes perform Import Application, then the assessed recovery action

`applyVerifiedRecoverApplication` builds a fresh Preview, captures the current
base, creates and drills a verified backup, then calls `applyLegacyImport`.
Interactive `/gsd recover --confirm` and `gsd headless recover` both delegate to
that boundary, then pass the committed Application to
`executeLegacyImportRecoveryAction`. They import modeled Markdown changes and
preserve database-only rows. The default action is `assess`: the read-only
restore assessor runs and the route states its recommendation in plain
language. Only an explicit `--restore` with evidence-bound destructive Consent
runs live restore, and only an explicit `--forward-repair` runs Forward Repair.
Neither route infers a restore request from the word `recover`.

S05 keeps Preview/Application as the explicit import route. Recovery after an
Application always assesses first and never restores as part of the import
itself.

### Live replacement semantics have exactly one owner

The database engine exposes global and isolated open, checkpoint, close,
close-all, and refresh-from-disk operations. Those remain process-handle
mechanics, not a safe replacement protocol. T05 made
`legacy-import-live-restore.ts` the sole crash-convergent owner of the complete
replacement boundary:

- cross-process quiescence across the final eligibility check and rename;
- staging beside the live database;
- WAL, SHM, and rollback-journal sidecar disposition;
- file and parent-directory durability ordering;
- a crash intent that distinguishes pre-publish from post-publish recovery;
- independent reopen verification of the installed live file; and
- an immutable receipt in the restored database for the erased Application.

Command handlers call the public restore function; they never compose these
low-level functions themselves.

### Existing recovery records are the wrong aggregate

`workflow_recovery_budgets` and `workflow_recovery_actions` route bounded
responses to Task/Lifecycle failures. They require lifecycle, Attempt, Failure
Observation, budget, and remediation relationships. A project database
replacement is not an Attempt retry or remediation action.

`lifecycle-shadow-repair-domain-operation.ts` repairs a narrow mismatch between
legacy lifecycle shadow state and canonical lifecycle state. It does not own
Import Application provenance, backup differences, or project-wide current
state.

Reusing either would weaken constraints and entangle unrelated policy. T02
will add the minimum project/import recovery receipts and reuse the common
operation, event, outbox, Projection Work, authority, Application, and backup
identities around them.

## Frozen state machine

The restore assessor is pure and read-only. It returns exactly one of these
decisions:

| Decision | Meaning | Next action |
|---|---|---|
| `transaction-rollback-only` | Import Application has not committed. | Let its owning transaction roll back; never run live restore. |
| `restore-consent-required` | The Application is the exact head and every non-consent gate passes. | Recommend lossless restore and ask for destructive Consent. |
| `restore-eligible` | The exact window remains open and valid Consent is present. | Recheck under exclusive coordination, then run live restore. |
| `forward-repair-required` | A later canonical operation or cutover permanently closed the window. | Build a current-state Forward Repair plan. |
| `temporarily-unavailable` | Authority is otherwise eligible but active coordination or a stale assessor prevents safe execution. | Retry after deterministic coordination repair or re-assess. |
| `refused` | Backup, project, schema, Application, or request evidence is invalid, missing, changed, or unsupported. | Explain the failed fact; do not mutate. |
| `already-restored` | The same content-addressed restore already committed. | Replay its durable receipt. |

Decision precedence is safety-first:

1. validate the strict request without reading accessors or accepting unknown
   fields;
2. detect an exact terminal restore or Forward Repair receipt, because a live
   restore deliberately erases its source Application aggregate;
3. otherwise load and validate the referenced committed Application;
4. prove project, root, schema, and backup identity;
5. prove whether any later operation or cutover exists;
6. if the window is still open, prove exact revision, epoch, current head,
   relevant-row hash, and coordination;
7. produce the exact difference review; and
8. require Consent only after every non-consent gate passes.

A later operation is historical evidence, not merely `current_revision >
application_revision`. Once observed, it closes the window even if another
operation later makes canonical rows byte-equivalent to the Application result.
The durable operation lineage is the fence.

## Typed boundary vocabulary

Names below freeze responsibilities, not implementation file layout.

### Cutover

- Request: one invocation, expected current revision/epoch, target authority
  contract version, evidence digest, and explicit irreversible Consent.
- Result: `committed` or `replayed`, operation ID, prior/resulting revision,
  prior/resulting epoch, evidence digest, event/outbox/Projection Work IDs, and
  recorded time.
- Operation type: `authority.cutover`.
- Invariant: revision advances exactly once and epoch advances exactly once.
  No other public request can select epoch advancement.

### Restore assessment

- Request: Application identity, verified-backup identity, and optional
  destructive Consent. The caller supplies no revision, epoch, current-head,
  difference, eligibility, force, or result fields.
- Result: one frozen decision from the state machine plus safe expected and
  observed project, schema, revision, epoch, head-operation, backup,
  coordination, Consent, and difference-digest facts.
- The assessor performs no transaction, checkpoint, file write, sidecar
  change, marker update, or projection render.

### Live restore

- Request: the complete frozen eligible assessment and invocation identity.
- Result: `committed` or `replayed`, restored backup identity, erased
  Application/operation range, installed database hash, resulting authority,
  restore receipt/event/outbox/Projection Work IDs, and verification facts.
- Operation type recorded in the restored database: `import.restore`.
- The public live-restore function owns the final recheck, handle lifecycle,
  staging, durability, publication, reopen verification, receipt, and bounded
  crash convergence. Callers cannot invoke its internal file steps.

### Forward Repair

- Plan input: verified backup base, committed Application Preview/receipt, and
  a fresh current canonical snapshot.
- Each target disposition is one of `safe-revert`, `already-repaired`,
  `later-modified`, `conflict`, `preserve`, or `choice-required`.
- Unambiguous plans preserve later/current work and may proceed automatically.
  Only a true same-target semantic overlap asks the user; the agent presents a
  recommended option and why.
- Result: `committed` or `replayed`, complete accepted/rejected disposition
  accounting, difference and plan digests, resulting revision/epoch, and exact
  operation/event/outbox/Projection Work identities.
- Operation type: `import.forward_repair`.
- Forward Repair never replaces database files, lowers epoch, rewrites backup
  artifacts, replays legacy history, or makes Markdown authoritative.

## Error contract

All three boundaries fail loud with a stable stage, code, retryability, and a
small frozen context containing IDs, hashes, counts, revisions, and epochs—not
raw imported content or secret-bearing paths.

Stable stages are:

- cutover: `contract`, `consent`, `coordination`, `transaction`, `receipt`;
- assessment: `contract`, `application`, `backup`, `authority`,
  `coordination`, `difference`;
- live restore: `recheck`, `checkpoint`, `stage`, `publish`, `reopen`,
  `verify`, `receipt`, `converge`;
- Forward Repair: `contract`, `base`, `plan`, `choice`, `transaction`,
  `receipt`.

Retryability never changes policy. Coordination contention, a stale read, or a
pre-publication filesystem interruption may be retryable. Later work, cutover,
invalid Consent, tampered evidence, incompatible project/schema, ambiguous
unresolved choice, and inconsistent durable receipts are not silently retried
as restore success.

## Crash and replay contract

Live database replacement is the only S05 action whose transaction cannot
cover every effect. Its recovery intent is therefore deliberately smaller than
a second authority store:

- content-addressed by the complete restore request;
- contains only safe identities, expected file hashes, stage, and paths under
  the owned recovery directory;
- authorizes convergence of the already-approved restore only;
- cannot authorize a new restore, change eligibility, choose Forward Repair
  dispositions, or reconstruct workflow truth; and
- is removed only after the restored database independently verifies and its
  durable receipt is present.

Before live publication, failure leaves the original database authoritative.
After live publication, restart must finish installing/verifying the selected
backup and recording the same restore receipt; it must never guess between two
database images. Competing identical requests converge on one receipt.
Different requests and a canonical writer racing the final fence produce one
winner and a typed refusal for the loser.

## User conversation contract

The agent recommends a route before asking:

- If restore is lossless and still eligible: “I recommend restoring the
  verified pre-import backup because no work has been accepted since the
  import. This replaces the current database. Proceed?”
- If later work or cutover exists: “I recommend Forward Repair because
  restoring would erase accepted work. I can preserve later changes and undo
  only import-attributable effects.”
- If a target is genuinely ambiguous: state the recommended disposition and
  why, show the material alternatives, and ask one plain-language choice.

Technical verification, backup checks, retries, unambiguous repair decisions,
and evidence capture do not block on a person. Silence or timeout is never
destructive Consent.

## Characterization evidence retained from S03/S04

T01 adds one focused behavior test beside the existing Domain Operation
contract. It proves an ordinary operation type can select epoch advancement;
the older `authority.handoff` example alone could be mistaken for a typed
cutover. Existing executable tests already freeze every other current behavior
required before production changes, so T01 does not duplicate them:

- `tests/domain-operation.test.ts` — `ordinary operations retain the epoch and
  explicit authority handoff advances it once` and `generic Domain Operation
  currently lets an ordinary operation select Authority Epoch advancement`
  prove the generic public request can advance Authority Epoch exactly once
  without semantic ownership by an authority operation.
- `tests/domain-operation.test.ts` — Import Application rejects epoch advance,
  stale epochs leave no residue, exact replay is stable, and every pre-commit
  fault rolls back.
- `tests/legacy-import-restore-drill.test.ts` — the drill verifies a distinct
  restored copy in a fresh process while leaving live database bytes and
  lineage untouched; corrupt and sidecar-contaminated artifacts refuse before
  staging.
- `tests/legacy-import-application-fault.test.ts` and
  `tests/legacy-import-application-public-corpus.test.ts` — Application
  transaction, crash/restart/contention, receipt, and corpus behavior.
- `tests/gsd-recover.test.ts` and `src/tests/headless-recover.test.ts` — both
  recovery routes delegate to verified Import Application rather than direct
  database replacement.

T03 must invert the generic epoch-advance characterization through the public
Domain Operation API. T04-T08 add new behavior-first acceptance tests for
assessment, live restore, Forward Repair, routing, and the public capstone.

## Explicit exclusions

S05 will not add:

- post-write restore with a review or force override;
- epoch decrement, down migration, or disk-authority restoration;
- a generic operation registry or caller-selected epoch strategy;
- reuse of Task recovery or lifecycle-shadow repair as import recovery;
- command-handler-owned file replacement;
- rollback derived from Markdown or Projection state;
- an external intent log that can become workflow authority;
- automatic guesses for true same-target semantic conflicts; or
- routine human approval for verifiable, reversible, or unambiguous repair.

## Implementation sequence

T02 resolved the receipt model as additive schema V45:

- `workflow_authority_cutovers` binds one epoch-advancing
  `authority.cutover` operation;
- `workflow_import_restores` retains checked erased-Application lineage
  without a foreign key to the erased aggregate; and
- `workflow_import_forward_repairs` requires the retained Application and its
  exact index-zero Application event, plus complete zero-unresolved plan
  accounting.

All three receipts and their linked operations are immutable. Fresh creation,
genuine V44 upgrade, pre-migration backup, injected-fault rollback with no
leaked V45 objects, independent backup reopen, exact causality, and sealed
legacy-corpus V45/V46 boundaries are executable tests.

1. T02 adds the minimum durable cutover, restore, and Forward Repair receipt
   model. (Completed.)
2. T03 makes epoch advancement private to one typed cutover operation.
   (Completed.)
3. T04 builds the pure exact restore assessor and recommendation result.
   (Completed: strict input and Consent snapshotting, one shared durable
   Application evidence reader, independently reverified backup bytes/base,
   exact post-Application relevant-row hash, current head and coordination
   fencing, deterministic difference digest, stale-read barrier, terminal
   route recognition, and recommendation-led frozen results.)
4. T05 implements one crash-safe eligible live restore and records erased
   lineage in the restored database. (Completed.)
5. T06 proves fault, SIGKILL, restart, stale-validator, and contention
   convergence.
6. T07 builds three-way import Forward Repair against current canonical state.
7. T08 seals public routes and the complete corpus across journal modes.

### T05 reconciled implementation research

Three independent code reviews converged on a smaller and stricter live
replacement boundary:

- The existing best-effort checkpoint, close-all, and refresh helpers cannot
  prove a safe replacement because they suppress checkpoint or close failures
  and the workspace cache can retain target adapters. T05 therefore adds one
  engine-owned strict detach/reopen token that pins the active file path,
  requires an exact completed checkpoint tuple, strictly closes every cached
  alias, preserves workspace identity, and fails before publication on any
  lifecycle error.
- One content-addressed intent directory beside the live database owns a
  same-filesystem candidate, safe request/lineage hashes, and the convergence
  stage. It is a recovery authorization for the already-approved request, not
  workflow authority. The V45 `workflow_import_restores` row remains the only
  terminal canonical receipt; no new authority table or schema version is
  needed.
- A presence-only sidecar check is insufficient because an already-open
  writer could commit through the replaced inode. The shared transaction
  entry points must honor a cooperative replacement fence. The restore owner
  holds the only scoped bypass across final assessment, strict detach,
  publication, reopen verification, and the typed `import.restore` receipt.
  A strict checkpoint drains transactions that began before the fence.
- `import.restore` is reserved from generic Domain Operation callers. Its
  typed private seam requires one exact matching receipt inside the same
  operation/event/outbox/projection/authority transaction on both commit and
  replay.
- The public request carries the invocation, supplied eligible assessment,
  original Application identity, verified backup, and the exact destructive
  Consent. The restore owner recomputes the assessment and requires exact
  equality, rather than trusting caller-selected eligibility or reconstructing
  Consent from an output hash.
- T05 implements the replacement as an exclusive, content-addressed intent
  with durable original/candidate file identities and an owner liveness
  fence. Abandoned pre-publication claims clean and restart only after the
  owner is inactive. A rename that survives before the next intent update is
  recovered from the staged candidate inode rather than stranded.
- The engine issues a single-use receipt capability only after it has closed
  every tracked handle, normalized the database to rollback-journal mode,
  measured the exact approved bytes immediately before reopen, and bound the
  reopened database to the exact active-intent inode and content. Restart
  convergence recopies and flushes the verified backup onto the proven
  candidate inode before repeating those checks; there is no presence-only
  adoption route.
- T05 acceptance covers the real-file happy path and erased lineage, strict
  input/final recheck, exact replay, competing owners, abandoned claims,
  pre-publication reopen, the rename/intent crash window, post-publication
  convergence, installed-byte tampering, intent inode replacement, unsafe
  intent paths, sidecar links, and unsupported directory durability. T06
  retains the exhaustive boundary-fault, real SIGKILL, startup,
  stale-validator, and multi-process contention matrices.

### T06 reconciled fault and contention research

T06 treats the filesystem protocol and the SQLite writer protocol as one
authority boundary. Three durable database states are valid:

- `A`: the post-Application database at revision `R+1`, epoch `E`, with its
  Application receipt and history intact;
- `B`: the verified pre-Application backup at revision `R`, epoch `E`, before
  a restore receipt commits; and
- `B+R`: the installed backup plus exactly one `import.restore` operation,
  receipt, event, outbox delivery, and Projection Work item at revision `R+1`
  and epoch `E`.

No exception, process death, restart, or race may produce another revision or
epoch combination. A cutover that wins before the restore claim may advance to
`E+1`; restore never lowers it.

#### Writer-wins serialization rule

The T05 cooperative intent fence is necessary but not sufficient. Its final
eligibility assessment and intent creation currently occur without SQLite's
reserved writer lock. A writer can therefore begin first, commit after the
last assessment, be included in the detach checkpoint, and then be erased by
publication. Writers that checked the fence before blocking on SQLite can also
begin after an intent appears unless the fence is checked again after the
writer lock is acquired. Direct autocommit writers bypass the transaction
entry fence entirely.

T06 freezes this ordering:

1. restore acquires `BEGIN IMMEDIATE` before its final eligibility check;
2. while holding that lock it re-reads exact Application, head, authority,
   coordination, and backup facts, atomically publishes and fsyncs its intent,
   then commits the claim transaction;
3. every ordinary production mutation acquires the same writer lock and
   rechecks the active intent after acquisition;
4. a writer or typed cutover already holding the lock commits first, so the
   restore's locked recheck observes the later work and routes to Forward
   Repair; and
5. a writer queued behind an accepted restore claim rolls back with typed,
   retryable replacement contention before changing a row.

The restore receipt retains its exact, single-use inode/content capability.
No generic force flag or writer bypass is added.

#### Crash boundary matrix

The deterministic harness uses fresh subprocesses, real `SIGKILL`, and pipe
handshakes. A child emits one `READY` record at a named synchronous boundary
and blocks on stdin; the parent inspects or starts a contender, then releases
or kills it. Timers are failure guards only, never scheduling primitives.
After child close, tests inspect raw paths, hashes, device/inode identities,
intent bytes, candidate bytes, and sidecars before any SQLite open. They then
use the defensive read-only adapter for integrity, foreign-key, authority, and
lineage checks.

The exhaustive boundaries are:

- locked final assessment and before intent claim;
- claim write, file fsync, no-replace publication, and directory fsync;
- candidate copy, candidate fsync, and independent candidate verification;
- claimed-to-staged intent publication and directory fsync;
- final assessment, strict checkpoint, journal-mode switch, tracked handle
  closes, and each live sidecar removal;
- immediately before and after the database rename, live-parent fsync,
  published-file verification, and staged-to-published intent publication;
- reopen before open, after open, and after exact inode/content proof;
- quick check, integrity check, foreign-key check, and exact base/
  representative verification;
- receipt transaction before commit, immediately after commit, and lost
  response;
- receipt-recorded intent, post-receipt checkpoint, database fsync, parent
  fsync, and terminal assessment; and
- candidate/temp removal, intent removal, recovery-directory removal, and
  cleanup parent fsync.

For deaths before publication, `A` remains authoritative and a fresh exact
retry cleans or reclaims only an abandoned matching intent. For deaths after
rename but before intent advancement, the live inode must equal the pinned
candidate and restart converges to `B+R`. For deaths before receipt commit,
the SQLite transaction leaves zero restore lineage and retry commits it once.
For deaths after receipt commit, a fresh process returns the complete stored
result as `replayed` and only finishes durable cleanup.

#### Faults the implementation must close before the matrix can pass

- Claim publication must be atomic and fully fsynced. Writing `active.json`
  directly permits a process death to leave malformed JSON that fails closed
  forever rather than converging.
- Recovery after a published rename must never overwrite the live database in
  place. It must stage, fsync, and atomically publish exact backup bytes again,
  or a death during copy can corrupt the only canonical path.
- Cleanup must converge if a death occurs after intent unlink but before
  recovery-directory removal. An exact empty owned directory is safe to remove
  during terminal replay; unknown residue is refused.
- Handle-close bookkeeping must remain recoverable when an adapter reports a
  close error after it has actually closed. A failed detach cannot leave a
  poisoned active/cache reference without a deterministic reopen route.

#### Required race proofs

- Same request: one exclusive owner commits; an active-owner loser receives
  retryable contention; a fresh retry replays the one durable receipt.
- Abandoned same request: after the owner is killed and observed dead, one
  contender reclaims and commits without duplicating lineage.
- Changed request: the loser cannot remove or alter the winner's intent or
  candidate and receives a typed refusal.
- Pre-claim canonical writer: its accepted operation survives, and restore
  refuses with later-operation Forward Repair evidence.
- Pre-claim typed cutover: its receipt and advanced epoch survive, and restore
  refuses with `AUTHORITY_CUTOVER_COMMITTED`.
- Post-claim queued writer: the post-lock fence rolls it back before mutation;
  it never writes the old inode or creates mixed sidecars.
- Lost response: only a process killed after durable receipt commit may have
  no response; exact retry returns identical operation and result identities.

Every injected exception and death is followed by an independent reopen.
Success requires one valid live database, no mixed or hot SQLite sidecars,
deterministic intent cleanup, preservation of all accepted history outside the
eligible Application rollback, and no silent success before durable receipt.

#### Adversarial review addendum

The first implementation pass exposed four additional authority gaps that the
final proof must include:

- Runtime memory CRUD, source, embedding, relation, maintenance, and backfill
  mutations are canonical database writes. They must use the same post-lock
  replacement fence as workflow writers; a memory-only change may not alter the
  restore assessment and could otherwise be silently overwritten.
- Startup schema/journal repair must acquire an exclusive SQLite writer lock,
  recheck the intent after acquiring it, and retain exclusive ownership through
  initialization. Schema-current startup may configure only connection-local,
  non-writing pragmas. A precheck alone has the same stale-validator race as an
  ordinary writer.
- Isolated observation handles are read-only and `query_only`. Observation
  soft-state mutations use the canonical fenced handle rather than turning an
  observational adapter into a second writer path.
- Recovery reopen evidence is state-specific: before the recovery candidate is
  published, an exception reopens the unchanged detached inode with no
  replacement claim; immediately after atomic publication it uses the exact
  recovery-staged inode/content/intent proof; after intent advancement it uses
  the exact published-intent proof.

Sidecar boundaries are distinct (`-wal`, `-shm`, and `-journal`) rather than one
repeated callback. Final verification copies the closed base database without
sidecars and independently proves its integrity and restore receipt, so a
surviving WAL cannot hide accepted history or make a mixed publication appear
valid.

PID existence is not process identity. Restore ownership therefore persists a
process-start identity and requires an exact `(pid, start identity)` match; a
reused PID is abandoned, while an indeterminate platform probe fails closed.
The detailed platform decision and reclaim protocol are recorded in
`M004-S05-T06-PID-OWNERSHIP-RESEARCH.md`.

Checkpoint and VACUUM are writers for replacement-coordination purposes even
though they do not add domain rows. They no longer run implicitly while a
connection closes. Explicit maintenance acquires `BEGIN IMMEDIATE`, rechecks
the replacement fence, publishes a fsynced process-identity maintenance intent,
then releases the SQLite transaction before the SQLite operation that cannot
run inside a transaction. Restore acquires the same writer lock and rechecks
that maintenance intent before claiming replacement. Thus whichever lock owner
wins proceeds; the loser returns typed retryable contention. A killed
maintenance owner is reclaimed only by mismatched/missing process-start
identity, never by age.
