# M004/S03 Verified Backup Research

Status: implemented and verified backup boundary.

## Decision

Import Application must fail closed until it has a verified, independently
openable SQLite backup bound to the exact approved Preview and canonical
database base. A backup is evidence, not merely a copied file.

The implementation uses parameter-bound `VACUUM INTO ?` to create the
snapshot. A strict `PRAGMA wal_checkpoint(TRUNCATE)` is still required as a
preflight gate, but it is not the consistency mechanism: another process can
commit after a successful checkpoint, so copying the live main database file
cannot close the cross-process WAL race. `VACUUM INTO` produces a consistent
snapshot containing committed data through the supported `node:sqlite`
provider. Node's online-backup API is not available across the project's Node
22 support floor.

## Required proof

Before publication, the backup pipeline must:

1. Reject a busy or malformed checkpoint result. In WAL mode, success requires
   `busy = 0` and every logged frame checkpointed. SQLite's rollback-journal
   `0, -1, -1` result is a documented not-applicable success.
2. Capture the approved base identity and `PRAGMA data_version`, create the
   snapshot, then prove that the base identity, relevant-row hash, source
   fingerprints, and data version did not drift.
3. Flush the staging file, calculate its SHA-256 and byte size, and open it
   independently in read-only mode without creating journals or sidecars.
4. Require `quick_check` and `integrity_check` to return exactly `ok`, require
   `foreign_key_check` to return no rows, and require the expected schema and
   project-authority anchors.
5. Publish by a content-addressed final name. Reuse is allowed only when the
   existing file has exactly the same verified content. A collision or partial
   publication fails loud.

The v1 verified-backup artifact binds the backup content to the approved
Preview hash and ID, Preview/importer versions, exact ordered source
fingerprints and source-set hash, project ID and real root, database schema,
project revision, Authority Epoch, relevant-row hash, backup SHA-256 and size,
and exact integrity results. `backup_id` is stable across retries: verification
time and the current storage reference are observations and are therefore not
part of that identity.

## Reuse and boundaries

- Reuse `workflow_import_applications` as the later durable application receipt;
  do not add a second backup-receipt table.
- Reuse the existing Preview base snapshot and relevant-row hash for approval
  binding.
- Extract only the narrow read-only SQLite opener needed for independent
  verification. The normal isolated workflow opener can negotiate WAL and
  create sidecars, so it is not suitable for verification.
- Keep backup destinations outside every declared Preview source root. Source
  capture is exhaustive, so placing backups under a source root would change
  the approved input set.
- S03 proves backup and isolated restore rehearsal. Live replacement, explicit
  consent, Authority Epoch changes, and Forward Repair belong to S05.

Recovery paths fail closed after a missing or failed backup and delegate to the
Preview/Application boundary; they do not continue destructive clearing.

## Failure contract

Failures are typed by stage and retryability. Contract failures are permanent.
Checkpoint busy, base/source drift, and transient publication races may be
retried only through bounded deterministic policy. Integrity, identity, and
publication-collision failures are never treated as successful degradation.

The implementation reports checkpoint busy/invalid, base or source drift,
snapshot/sync/hash failure, independent-open failure, integrity or foreign-key
failure, identity mismatch, and publication collision/failure only from the
corresponding stages.

## Primary references

- SQLite, [`VACUUM INTO`](https://sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)
- SQLite, [`PRAGMA wal_checkpoint`](https://sqlite.org/pragma.html#pragma_wal_checkpoint)
- SQLite, [`PRAGMA data_version`](https://sqlite.org/pragma.html#pragma_data_version)
- SQLite, [`PRAGMA integrity_check`](https://sqlite.org/pragma.html#pragma_integrity_check)
- SQLite, [`PRAGMA quick_check`](https://sqlite.org/pragma.html#pragma_quick_check)
- SQLite, [`PRAGMA foreign_key_check`](https://sqlite.org/pragma.html#pragma_foreign_key_check)
- SQLite, [WAL file lifecycle](https://sqlite.org/wal.html#the_wal_file)
- SQLite, [How database corruption can occur](https://sqlite.org/howtocorrupt.html)
- SQLite, [Online backup API](https://sqlite.org/backup.html)
- Node.js, [`sqlite.backup()` version history](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#sqlitebackup-sourcedb-path-options)
