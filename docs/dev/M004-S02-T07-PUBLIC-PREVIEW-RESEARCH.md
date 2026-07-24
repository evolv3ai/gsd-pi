# M004/S02/T07 Public Preview research

Status: implemented and verified public Preview boundary.

## Decision

`createLegacyImportPreview` is the only public composition boundary for a legacy import Preview. It:

1. captures every declared source root into one stable retained-byte snapshot;
2. captures one atomic schema-v45 canonical base snapshot from the already-open database;
3. assigns every retained non-directory source to exactly one interpreter;
4. interprets and classifies entirely in memory;
5. re-enumerates and rehashes the declared source roots;
6. captures the canonical base a second time and compares the complete approval tuple;
7. seals and returns only `{ preview, preview_hash }`.

`revalidateLegacyImportPreview` recreates the Preview through the same boundary and compares its exact hash with the expected sealed artifact. It does not add hidden approval state or reread legacy input during a later application.

## Existing guarantees to reuse

- Source capture already double-captures and rejects byte, path, identity, symlink, addition, removal, or ordering drift.
- Source revalidation recaptures the declared roots and compares the full capture identity.
- Base capture already reads schema, project authority, and all ten relevant canonical row sets inside one read transaction.
- Base identity includes schema, project/root, revision, Authority Epoch, and a canonical hash of every relevant row.
- Candidate database inspection operates on a private retained-byte copy, opens it read-only, fingerprints it after inspection, and removes the copy.
- Classification and sealing are pure, clone their inputs, validate hashes and evidence, canonically order output, and deeply freeze the result.

## Source ownership

The public boundary must not run every interpreter over every source and merge the results optimistically.

- Planning already selects `.planning/**`.
- Supplemental contributors can claim database targets, histories, workflows, graphs, knowledge, root projections, and worktree topology from a shared decoded capture.
- GSD hierarchy/truth interpretation must receive an in-memory view that excludes supplemental-owned sources.
- The final composition must reject a retained source that is missing or multiply owned.
- The ownership partition is an in-memory view over the original retained bytes; it must never reread the filesystem.

This avoids a second hand-maintained surface registry and prevents GSD's fallback preservation from duplicating supplemental evidence.

## Resolved lifecycle database evidence gap

The lifecycle corpus originally built `LegacyImportGsdDatabaseEvidence` only in a test helper. The production database-target inspector recorded schema and target suitability but did not collect `slices.depends` and `slice_dependencies.depends_on_slice_id` observations.

T07 added a production retained-byte collector for those complete row sets. The collector:

- inspects only the retained private copy;
- binds observations to the source capture/hash and inspection version;
- reports complete coverage and stable ordering;
- attaches exact source byte spans when uniquely recoverable;
- fails closed when a value cannot be bound to unique retained bytes;
- performs no migration, checkpoint, backup, replay, projection, receipt, or authoritative write.

## Race boundary

The required order is source A, base A, pure interpretation/classification, source revalidation, base B, exact A/B comparison, then seal. This covers source drift during interpretation, concurrent canonical writers, and out-of-band relevant-row changes that fail to advance revision.

S04 revalidates the sealed Preview, enforces revision/epoch inside its write transaction, and applies only sealed normalized changes. Revalidation does not lock the filesystem and never authorizes rereading legacy bytes during application.

## Error boundary

Valid ambiguity remains Preview data. Infrastructure or identity inconsistency throws a typed, redacted error with stage, stable code, retryability, and expected/observed hashes or base tuple fields. A public call never returns a partial artifact.

## Verification coverage

- Focused source, interpreter, classifier, inspector, seal, and corpus-validator suites remain the component owners.
- A table-driven public-path sweep covers all 26 corpus cases without duplicating their unit contracts.
- Deterministic public replay compares exactly. Historical hand-authored corpus oracles compare through an ID-normalized semantic projection because their IDs are fixture labels and T06 deliberately tightened composite completeness behavior.
- Exact action-matrix, lifecycle-database, and stricter composite capstones remain focused.
- No-write proofs cover source trees, database tables, `project_authority`, coordination/event/outbox/projection/import tables, `total_changes`, database/WAL/SHM fingerprints, backup inventory, projection files, and receipts.
- Sabotage coverage exercises final source/base revalidation, parser/importer identity, diagnoses/resolutions/counts, source ownership, and attempted writer/backup/receipt/projector reachability.

GitHub labels and tags are not inputs to this contract.
