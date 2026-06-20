// gsd-pi / V27 + V28 + V29 schema migration regression tests
//
// Same bug class as #4591 (schema-v21-sequence): a migration block can be
// added but the SCHEMA_VERSION constant left unchanged, causing fresh-install
// + upgrade paths to silently skip the column add. This file pins V27
// (artifacts.content_hash), V28 (memories.last_hit_at), and V29
// (target_repositories) at the schema/write-path level.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";

import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertArtifact,
  insertMemoryRow,
  incrementMemoryHitCount,
  SCHEMA_VERSION,
} from "../gsd-db.ts";

const _require = createRequire(import.meta.url);

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsd-v27v29-"));
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function columnNames(table: string): Set<string> {
  const db = _getAdapter()!;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  return new Set(cols.map((c) => c["name"] as string));
}

function createV28Db(dbPath: string): void {
  const sqlite = _require("node:sqlite") as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      close(): void;
    };
  };
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (28, '2026-01-01T00:00:00.000Z');

    CREATE TABLE milestones (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      depends_on TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT DEFAULT NULL,
      vision TEXT NOT NULL DEFAULT '',
      success_criteria TEXT NOT NULL DEFAULT '[]',
      key_risks TEXT NOT NULL DEFAULT '[]',
      proof_strategy TEXT NOT NULL DEFAULT '[]',
      verification_contract TEXT NOT NULL DEFAULT '',
      verification_integration TEXT NOT NULL DEFAULT '',
      verification_operational TEXT NOT NULL DEFAULT '',
      verification_uat TEXT NOT NULL DEFAULT '',
      definition_of_done TEXT NOT NULL DEFAULT '[]',
      requirement_coverage TEXT NOT NULL DEFAULT '',
      boundary_map_markdown TEXT NOT NULL DEFAULT '',
      sequence INTEGER DEFAULT 0
    );
    CREATE TABLE slices (
      milestone_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      risk TEXT NOT NULL DEFAULT 'medium',
      depends TEXT NOT NULL DEFAULT '[]',
      demo TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT DEFAULT NULL,
      full_summary_md TEXT NOT NULL DEFAULT '',
      full_uat_md TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      success_criteria TEXT NOT NULL DEFAULT '',
      proof_level TEXT NOT NULL DEFAULT '',
      integration_closure TEXT NOT NULL DEFAULT '',
      observability_impact TEXT NOT NULL DEFAULT '',
      sequence INTEGER DEFAULT 0,
      replan_triggered_at TEXT DEFAULT NULL,
      is_sketch INTEGER NOT NULL DEFAULT 0,
      sketch_scope TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (milestone_id, id),
      FOREIGN KEY (milestone_id) REFERENCES milestones(id)
    );
    CREATE TABLE tasks (
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      one_liner TEXT NOT NULL DEFAULT '',
      narrative TEXT NOT NULL DEFAULT '',
      verification_result TEXT NOT NULL DEFAULT '',
      duration TEXT NOT NULL DEFAULT '',
      completed_at TEXT DEFAULT NULL,
      blocker_discovered INTEGER DEFAULT 0,
      blocker_source TEXT NOT NULL DEFAULT '',
      escalation_pending INTEGER NOT NULL DEFAULT 0,
      escalation_awaiting_review INTEGER NOT NULL DEFAULT 0,
      escalation_artifact_path TEXT DEFAULT NULL,
      escalation_override_applied_at TEXT DEFAULT NULL,
      deviations TEXT NOT NULL DEFAULT '',
      known_issues TEXT NOT NULL DEFAULT '',
      key_files TEXT NOT NULL DEFAULT '[]',
      key_decisions TEXT NOT NULL DEFAULT '[]',
      full_summary_md TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      estimate TEXT NOT NULL DEFAULT '',
      files TEXT NOT NULL DEFAULT '[]',
      verify TEXT NOT NULL DEFAULT '',
      inputs TEXT NOT NULL DEFAULT '[]',
      expected_output TEXT NOT NULL DEFAULT '[]',
      observability_impact TEXT NOT NULL DEFAULT '',
      full_plan_md TEXT NOT NULL DEFAULT '',
      sequence INTEGER DEFAULT 0,
      PRIMARY KEY (milestone_id, slice_id, id),
      FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
    );
  `);
  db.close();
}

test("SCHEMA_VERSION constant is at least 29 (V29 migration committed)", () => {
  assert.ok(
    SCHEMA_VERSION >= 29,
    `SCHEMA_VERSION must be ≥ 29 after V29 migration; got ${SCHEMA_VERSION}`,
  );
});

test("fresh-install DB has artifacts.content_hash column (V27)", () => {
  const base = makeTmp();
  const dbPath = path.join(base, "gsd.db");
  try {
    openDatabase(dbPath);
    assert.ok(
      columnNames("artifacts").has("content_hash"),
      "V27 must add content_hash column to artifacts on fresh install",
    );
  } finally {
    cleanup(base);
  }
});

test("fresh-install DB has memories.last_hit_at column (V28)", () => {
  const base = makeTmp();
  const dbPath = path.join(base, "gsd.db");
  try {
    openDatabase(dbPath);
    assert.ok(
      columnNames("memories").has("last_hit_at"),
      "V28 must add last_hit_at column to memories on fresh install",
    );
  } finally {
    cleanup(base);
  }
});

test("fresh-install DB has target_repositories columns (V29)", () => {
  const base = makeTmp();
  const dbPath = path.join(base, "gsd.db");
  try {
    openDatabase(dbPath);
    assert.ok(
      columnNames("slices").has("target_repositories"),
      "V29 must add target_repositories column to slices on fresh install",
    );
    assert.ok(
      columnNames("tasks").has("target_repositories"),
      "V29 must add target_repositories column to tasks on fresh install",
    );
  } finally {
    cleanup(base);
  }
});

test("fresh-install DB stamps current SCHEMA_VERSION in schema_version table", () => {
  const base = makeTmp();
  const dbPath = path.join(base, "gsd.db");
  try {
    openDatabase(dbPath);
    const db = _getAdapter()!;
    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as Record<string, unknown> | undefined;
    const max = (row?.["v"] as number) ?? 0;
    assert.equal(max, SCHEMA_VERSION, `fresh install must record schema_version ${SCHEMA_VERSION}; got ${max}`);
  } finally {
    cleanup(base);
  }
});

test("upgrading from V28 adds target_repositories and stamps V29", () => {
  const base = makeTmp();
  const dbPath = path.join(base, "gsd.db");
  createV28Db(dbPath);

  try {
    openDatabase(dbPath);
    assert.ok(
      columnNames("slices").has("target_repositories"),
      "V29 migration must add target_repositories column to existing slices table",
    );
    assert.ok(
      columnNames("tasks").has("target_repositories"),
      "V29 migration must add target_repositories column to existing tasks table",
    );

    const db = _getAdapter()!;
    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as Record<string, unknown> | undefined;
    const max = (row?.["v"] as number) ?? 0;
    assert.equal(max, SCHEMA_VERSION, `V28 DB must upgrade to schema_version ${SCHEMA_VERSION}; got ${max}`);
  } finally {
    cleanup(base);
  }
});

test("insertArtifact populates content_hash with SHA-256 of full_content (V27 write-path)", () => {
  const base = makeTmp();
  const dbPath = path.join(base, "gsd.db");
  try {
    openDatabase(dbPath);
    insertArtifact({
      path: "M001/PROJECT.md",
      artifact_type: "PROJECT",
      milestone_id: "M001",
      slice_id: null,
      task_id: null,
      full_content: "hello world",
    });

    const db = _getAdapter()!;
    const row = db
      .prepare("SELECT content_hash FROM artifacts WHERE path = :p")
      .get({ ":p": "M001/PROJECT.md" }) as Record<string, unknown> | undefined;
    const hash = row?.["content_hash"] as string | null | undefined;

    // SHA-256 of "hello world" hex-encoded:
    const expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    assert.equal(hash, expected, "content_hash must be SHA-256 hex of full_content");
  } finally {
    cleanup(base);
  }
});

test("incrementMemoryHitCount sets last_hit_at alongside hit_count (V28 write-path)", () => {
  const base = makeTmp();
  const dbPath = path.join(base, "gsd.db");
  try {
    openDatabase(dbPath);

    const created = "2026-01-01T00:00:00.000Z";
    insertMemoryRow({
      id: "MEM001",
      category: "gotcha",
      content: "test memory",
      confidence: 0.9,
      sourceUnitType: null,
      sourceUnitId: null,
      createdAt: created,
      updatedAt: created,
      scope: "project",
      tags: [],
      structuredFields: null,
    });

    // Before increment: last_hit_at should be NULL
    const db = _getAdapter()!;
    const before = db
      .prepare("SELECT last_hit_at FROM memories WHERE id = :id")
      .get({ ":id": "MEM001" }) as Record<string, unknown>;
    assert.equal(before["last_hit_at"], null, "last_hit_at starts NULL on fresh insert");

    const hitTime = "2026-02-01T00:00:00.000Z";
    incrementMemoryHitCount("MEM001", hitTime);

    const after = db
      .prepare("SELECT hit_count, last_hit_at FROM memories WHERE id = :id")
      .get({ ":id": "MEM001" }) as Record<string, unknown>;
    assert.equal(after["hit_count"], 1, "hit_count increments");
    assert.equal(after["last_hit_at"], hitTime, "last_hit_at set to provided timestamp");
  } finally {
    cleanup(base);
  }
});
