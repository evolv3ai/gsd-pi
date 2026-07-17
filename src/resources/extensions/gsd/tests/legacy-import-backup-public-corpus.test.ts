// Project/App: gsd-pi
// File Purpose: Public Preview-to-backup restore rehearsal across the sealed legacy corpus.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  prepareLegacyImportBackup,
  validateLegacyImportVerifiedBackup,
  verifyLegacyImportBackupArtifact,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import {
  createLegacyImportPreview,
  hashLegacyImportValue,
  revalidateLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";
import { drillLegacyImportBackupRestore } from "../legacy-import-restore-drill.ts";
import { _getAdapter, closeDatabase, insertDecision, openDatabase } from "../gsd-db.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";
import {
  createLegacyImportCorpusSourceRoots,
  fingerprintLegacyImportCorpusTree,
  type LegacyImportCorpusManifest,
} from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const CORPUS_PATH = fileURLToPath(CORPUS_ROOT);
const MANIFEST = JSON.parse(readFileSync(join(CORPUS_PATH, "corpus.json"), "utf8")) as LegacyImportCorpusManifest;
const JOURNAL_MODES = ["delete", "wal"] as const;
const WRITE_SURFACE_TABLES = [
  "workflow_operations",
  "workflow_domain_events",
  "workflow_outbox",
  "workflow_projection_work",
  "workflow_import_applications",
  "workflow_settlement_receipts",
  "workflow_recovery_actions",
  "workflow_recovery_budgets",
] as const;

function seedActionMatrixBase(source: string): void {
  const fixture = openSqliteReadOnly(join(source, ".gsd", "gsd.db"));
  try {
    const rows = fixture.db.prepare(`
      SELECT id, when_context, scope, decision, choice, rationale, revisable,
             made_by, source, superseded_by
      FROM decisions
      WHERE id IN ('D002', 'D003', 'D004')
      ORDER BY id
    `).all() as unknown as Array<Parameters<typeof insertDecision>[0]>;
    assert.deepEqual(rows.map((row) => row.id), ["D002", "D003", "D004"]);
    rows.forEach(insertDecision);
  } finally {
    fixture.db.close();
  }
}

function insertJournalSentinel(id: string): void {
  insertDecision({
    id,
    when_context: "before verified legacy recovery backup",
    scope: "backup-public-corpus-test",
    decision: id,
    choice: "committed",
    rationale: "prove committed WAL frames are captured by the verified backup",
    revisable: "no",
    made_by: "agent",
    source: "discussion",
    superseded_by: null,
  });
}

function canonicalWriteSurfaces(): Record<string, string> {
  const database = _getAdapter();
  assert.ok(database);
  return Object.fromEntries(WRITE_SURFACE_TABLES.map((table) => [
    table,
    hashLegacyImportValue(database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()),
  ]));
}

function totalChanges(): unknown {
  const database = _getAdapter();
  assert.ok(database);
  return database.prepare("SELECT total_changes() AS count").get()?.["count"];
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

test("every sealed corpus Preview produces a verified backup that passes an isolated restore drill in rollback and WAL modes", (t) => {
  assert.equal(MANIFEST.cases.length, 26);
  const workspace = mkdtempSync(join(tmpdir(), "gsd-backup-public-corpus-"));
  t.after(() => {
    closeDatabase();
    rmSync(workspace, { recursive: true, force: true });
  });
  let completedRuns = 0;
  let unresolvedRuns = 0;

  for (const entry of MANIFEST.cases) {
    for (const journalMode of JOURNAL_MODES) {
      const runName = `${entry.name}/${journalMode}`;
      const runRoot = join(workspace, entry.name, journalMode);
      const source = join(runRoot, "source");
      const destination = join(runRoot, "backups");
      const databasePath = join(runRoot, "canonical.sqlite");
      cpSync(join(CORPUS_PATH, entry.name, "source"), source, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      mkdirSync(destination);
      assert.equal(openDatabase(databasePath), true, runName);

      try {
        const database = _getAdapter();
        assert.ok(database);
        const observedMode = database.prepare(`PRAGMA journal_mode=${journalMode}`).get()?.["journal_mode"];
        assert.equal(observedMode, journalMode, `${runName}: requested journal mode`);
        if (entry.name === "action-matrix") seedActionMatrixBase(source);

        const sentinel = `D-${entry.name}-${journalMode}-${completedRuns}`;
        insertJournalSentinel(sentinel);
        if (journalMode === "wal") {
          const walPath = `${databasePath}-wal`;
          assert.ok(statSync(walPath).size > 0, `${runName}: committed WAL is nonempty`);
          assert.ok(readFileSync(walPath).includes(Buffer.from(sentinel)), `${runName}: sentinel is in the WAL`);
        }

        const roots = createLegacyImportCorpusSourceRoots(source);
        const input = { roots };
        const sourceBefore = fingerprintLegacyImportCorpusTree(source);
        const canonicalBaseBefore = captureCurrentLegacyImportBaseSnapshot();
        const writeSurfacesBefore = canonicalWriteSurfaces();
        const changesBefore = totalChanges();
        const preview = createLegacyImportPreview(input);

        assert.deepEqual(createLegacyImportPreview(input), preview, `${runName}: exact Preview replay`);
        assert.deepEqual(revalidateLegacyImportPreview(input, preview), preview, `${runName}: Preview revalidation`);
        assert.deepEqual(
          captureCurrentLegacyImportBaseSnapshot(),
          canonicalBaseBefore,
          `${runName}: captured approved base`,
        );

        const backup = prepareLegacyImportBackup({
          preview,
          base: canonicalBaseBefore,
          roots,
          destination_directory: destination,
          label: "pre-recover",
        });
        assertBackupArtifact(backup, preview, canonicalBaseBefore, destination, runName);
        if (preview.preview.counts.unresolved > 0) unresolvedRuns += 1;

        const backupHashBefore = sha256(backup.backup_ref);
        const verification = verifyLegacyImportBackupArtifact({
          backup,
          preview,
          base: canonicalBaseBefore,
        });
        assert.deepEqual(verification.independent_base, canonicalBaseBefore, `${runName}: independent base`);
        assert.equal(verification.opened_path, backup.backup_ref, `${runName}: independently opened artifact`);
        assert.equal(Object.isFrozen(verification), true, `${runName}: frozen independent evidence`);
        assert.deepEqual(drillLegacyImportBackupRestore({
          backup,
          preview,
          base: canonicalBaseBefore,
        }), {
          backup_id: backup.backup_id,
          backup_sha256: backup.backup_sha256,
          backup_byte_size: backup.backup_byte_size,
          quick_check: "ok",
          integrity_check: "ok",
          foreign_key_violations: 0,
          representative_queries: "ok",
        }, `${runName}: exact restore-drill result`);

        assert.equal(sha256(backup.backup_ref), backupHashBefore, `${runName}: backup bytes unchanged`);
        assert.equal(
          fingerprintLegacyImportCorpusTree(source),
          sourceBefore,
          `${runName}: source inventory unchanged`,
        );
        assert.deepEqual(captureCurrentLegacyImportBaseSnapshot(), canonicalBaseBefore, `${runName}: canonical authority unchanged`);
        assert.deepEqual(canonicalWriteSurfaces(), writeSurfacesBefore, `${runName}: no workflow writes`);
        assert.equal(totalChanges(), changesBefore, `${runName}: no canonical writes`);
        assert.deepEqual(readdirSync(destination), [basename(backup.backup_ref)], `${runName}: one published artifact`);
        completedRuns += 1;
      } finally {
        closeDatabase();
      }
    }
  }

  assert.equal(completedRuns, 52);
  assert.ok(unresolvedRuns > 0, "corpus must prove unresolved Previews remain backup-eligible");
});

function assertBackupArtifact(
  backup: LegacyImportVerifiedBackup,
  preview: LegacyImportPreviewArtifact,
  base: LegacyImportBaseSnapshot,
  destination: string,
  runName: string,
): void {
  assertDeepFrozen(backup);
  assert.deepEqual(validateLegacyImportVerifiedBackup(structuredClone(backup), {
    preview,
    base,
  }), backup, `${runName}: strict verified artifact`);
  assert.match(basename(backup.backup_ref), new RegExp(`^pre-recover-${backup.backup_id.slice(7)}\\.sqlite$`, "u"));
  assert.equal(backup.backup_sha256, sha256(backup.backup_ref), `${runName}: exact backup hash`);
  assert.equal(backup.backup_byte_size, statSync(backup.backup_ref).size, `${runName}: exact backup size`);
  assert.equal(backup.quick_check, "ok");
  assert.equal(backup.integrity_check, "ok");
  assert.equal(backup.foreign_key_violations, 0);
  assert.deepEqual(readdirSync(destination), [basename(backup.backup_ref)], `${runName}: no backup sidecars`);
}
