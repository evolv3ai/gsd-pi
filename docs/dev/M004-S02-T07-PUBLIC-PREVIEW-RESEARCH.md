# M004/S02/T07 Public Preview research

## Decision

`createLegacyImportPreview` will be the only public composition boundary for a legacy import Preview. It will:

1. capture every declared source root into one stable retained-byte snapshot;
2. capture one atomic schema-v45 canonical base snapshot from the already-open database;
3. assign every retained non-directory source to exactly one interpreter;
4. interpret and classify entirely in memory;
5. re-enumerate and rehash the declared source roots;
6. capture the canonical base a second time and compare the complete approval tuple;
7. seal and return only `{ preview, preview_hash }`.

`revalidateLegacyImportPreview` will recreate the Preview through the same boundary and compare its exact hash with the expected sealed artifact. It will not add hidden approval state or reread legacy input during a later application.

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

## Lifecycle database evidence gap

The lifecycle corpus currently builds `LegacyImportGsdDatabaseEvidence` only in a test helper. The production database-target inspector records schema and target suitability but does not collect `slices.depends` and `slice_dependencies.depends_on_slice_id` observations.

T07 must add a production retained-byte collector for those complete row sets, or the public path cannot honestly reproduce the lifecycle corpus. The collector must:

- inspect only the retained private copy;
- bind observations to the source capture/hash and inspection version;
- report complete coverage and stable ordering;
- attach exact source byte spans when uniquely recoverable;
- fail closed when a value cannot be bound to unique retained bytes;
- perform no migration, checkpoint, backup, replay, projection, receipt, or authoritative write.

## Race boundary

The required order is source A, base A, pure interpretation/classification, source revalidation, base B, exact A/B comparison, then seal. This covers source drift during interpretation, concurrent canonical writers, and out-of-band relevant-row changes that fail to advance revision.

S04 must still revalidate the sealed Preview, enforce revision/epoch inside its write transaction, and apply only sealed normalized changes. Revalidation does not lock the filesystem and must never authorize rereading legacy bytes during application.

## Error boundary

Valid ambiguity remains Preview data. Infrastructure or identity inconsistency throws a typed, redacted error with stage, stable code, retryability, and expected/observed hashes or base tuple fields. A public call never returns a partial artifact.

## Verification lean

- Keep existing focused source, interpreter, classifier, inspector, seal, and corpus-validator suites as component owners.
- Add a table-driven public-path sweep over all 26 corpus cases rather than duplicating their unit contracts.
- Compare deterministic public replay exactly. Compare the historical hand-authored corpus oracles through an ID-normalized semantic projection because their IDs are fixture labels and T06 deliberately tightened composite completeness behavior.
- Keep small exact action-matrix, lifecycle-database, and stricter composite capstones.
- Prove source trees, database tables, `project_authority`, coordination/event/outbox/projection/import tables, `total_changes`, database/WAL/SHM fingerprints, backup inventory, projection files, and receipts are unchanged.
- Sabotage final source/base revalidation, parser/importer identity, diagnoses/resolutions/counts, source ownership, and attempted writer/backup/receipt/projector reachability.

GitHub labels and tags are not inputs to this contract.
