// Project/App: gsd-pi
// File Purpose: Memory FTS5 SQLite schema helpers for the GSD database facade.

import type { DbAdapter } from "./db-adapter.js";
import { createRuntimeKvTableV25, hasRuntimeKvSchemaV25 } from "./db-runtime-kv-schema.js";

export const MEMORIES_FTS_REBUILT_KEY = "memories_fts_rebuilt_at";
let memoriesFtsRebuildBoundaryForTest: (() => void) | null = null;

export function _setMemoriesFtsRebuildBoundaryForTest(boundary: (() => void) | null): void {
  memoriesFtsRebuildBoundaryForTest = boundary;
}

export interface MemoryFtsSchemaOptions {
  onUnavailable?: (message: string) => void;
}

export interface MemoryFtsRebuildOptions {
  force?: boolean;
  onRebuildFailed?: (message: string) => void;
  transactionOpen?: boolean;
}

export interface MemoryFtsStartupState {
  readonly supported: boolean;
  readonly schemaComplete: boolean;
  readonly rebuildMarked: boolean;
}

function formatFtsUnavailableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\bmoduel\s*:\s*/gi, "module: ");
}

/**
 * Create the FTS5 virtual table for memories plus the triggers that keep it
 * in sync with the base table. FTS5 may be unavailable on stripped-down
 * SQLite builds — callers should treat failure as non-fatal and fall back
 * to LIKE-based scans in `memory-store.queryMemoriesRanked`.
 */
export function tryCreateMemoriesFtsSchema(
  db: DbAdapter,
  options: MemoryFtsSchemaOptions = {},
): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(content, content='memories', content_rowid='seq', tokenize='porter unicode61')
    `);
    // Triggers mirror inserts / updates / deletes on the base memories table.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai
      AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad
      AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au
      AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
      END
    `);
    return true;
  } catch (err) {
    options.onUnavailable?.(`FTS5 unavailable — memory queries will use LIKE fallback: ${formatFtsUnavailableError(err)}`);
    return false;
  }
}

export function isMemoriesFtsAvailableSchema(db: DbAdapter): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get();
    return !!row;
  } catch {
    return false;
  }
}

export function inspectMemoriesFtsStartupState(db: DbAdapter): MemoryFtsStartupState {
  try {
    db.prepare("SELECT fts5_source_id() AS source_id").get();
  } catch (error) {
    if (!/no such function:\s*fts5_source_id/iu.test(String(error))) throw error;
    return { supported: false, schemaComplete: true, rebuildMarked: true };
  }

  const schema = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE (type = 'table' AND name = 'memories_fts')
      OR (type = 'trigger' AND name IN ('memories_ai', 'memories_ad', 'memories_au'))
  `).get();
  const schemaComplete = Number(schema?.["count"]) === 4;
  const rebuildMarked = hasRuntimeKvSchemaV25(db) && db.prepare(
    "SELECT 1 AS present FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :key",
  ).get({ ":key": MEMORIES_FTS_REBUILT_KEY }) !== undefined;
  return { supported: true, schemaComplete, rebuildMarked };
}

export function invalidateMemoriesFtsRebuildMarker(db: DbAdapter): void {
  if (!hasRuntimeKvSchemaV25(db)) return;
  db.prepare(
    "DELETE FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :key",
  ).run({ ":key": MEMORIES_FTS_REBUILT_KEY });
}

export function rebuildMemoriesFtsSchemaOnce(
  db: DbAdapter,
  options: MemoryFtsRebuildOptions = {},
): void {
  if (!isMemoriesFtsAvailableSchema(db)) {
    if (options.force) throw new Error("FTS5 schema is unavailable after repair");
    return;
  }

  createRuntimeKvTableV25(db);
  const marker = db.prepare(
    "SELECT 1 as present FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :key",
  ).get({ ":key": MEMORIES_FTS_REBUILT_KEY });
  if (marker && !options.force) return;

  const now = new Date().toISOString();
  const begin = options.transactionOpen ? "SAVEPOINT memories_fts_rebuild" : "BEGIN";
  const commit = options.transactionOpen ? "RELEASE SAVEPOINT memories_fts_rebuild" : "COMMIT";
  const rollback = options.transactionOpen
    ? "ROLLBACK TO SAVEPOINT memories_fts_rebuild; RELEASE SAVEPOINT memories_fts_rebuild"
    : "ROLLBACK";
  try {
    db.exec(begin);
    memoriesFtsRebuildBoundaryForTest?.();
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    db.prepare(
      `INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
       VALUES ('global', '', :key, :value_json, :updated_at)
       ON CONFLICT (scope, scope_id, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    ).run({
      ":key": MEMORIES_FTS_REBUILT_KEY,
      ":value_json": JSON.stringify(now),
      ":updated_at": now,
    });
    db.exec(commit);
  } catch (err) {
    try {
      db.exec(rollback);
    } catch {
      // Best effort: leave startup alive and retry the rebuild on next open.
    }
    options.onRebuildFailed?.(`FTS5 rebuild failed: ${(err as Error).message}`);
    if (options.force) throw err;
  }
}
