// gsd-pi — sqlite-readonly provider capability errors and staleness guard tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  openSqliteReadOnly,
  SqliteReadOnlyCapabilityUnavailableError,
  SqliteReadOnlyProviderUnavailableError,
  _setSqliteReadOnlyNodeSqliteLoaderForTest,
} from "../sqlite-readonly.ts";
import { GSD_STALE_STATE } from "../errors.ts";

function makeDatabase(t: test.TestContext): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-sqlite-readonly-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "fixture.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  db.close();
  return { dir, path };
}

test("immutable read-only inspection reports an unsupported capability, not a missing provider", (t) => {
  const { path } = makeDatabase(t);
  _setSqliteReadOnlyNodeSqliteLoaderForTest(() => undefined);
  t.after(() => _setSqliteReadOnlyNodeSqliteLoaderForTest(null));

  assert.throws(
    () => openSqliteReadOnly(path, { immutable: true }),
    (error: unknown) => {
      assert.ok(
        error instanceof SqliteReadOnlyCapabilityUnavailableError,
        `expected SqliteReadOnlyCapabilityUnavailableError, got ${String(error)}`,
      );
      assert.ok(!(error instanceof SqliteReadOnlyProviderUnavailableError));
      assert.match(String(error), /does not support/i);
      assert.match(String(error), /immutable/i);
      return true;
    },
  );
});

test("immutable read-only inspection still opens through node:sqlite when available", (t) => {
  const { path } = makeDatabase(t);
  const connection = openSqliteReadOnly(path, { immutable: true });
  t.after(() => connection.db.close());

  assert.deepEqual(
    connection.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'items'").get(),
    { name: "items" },
  );
});

test("read-only staleness guard throws GSD_STALE_STATE when the path identity changes", (t) => {
  const { dir, path } = makeDatabase(t);
  const connection = openSqliteReadOnly(path);
  t.after(() => {
    try {
      connection.db.close();
    } catch {
      // The handle may already be detached; cleanup is best-effort.
    }
  });
  assert.equal(connection.db.prepare("SELECT COUNT(*) AS count FROM items").get()?.["count"], 0);

  // Swap a different file in at the same path: the open handle's recorded
  // identity no longer matches the path, matching the engine.ts GSD_STALE_STATE
  // contract for a detached handle.
  const replacement = join(dir, "replacement.db");
  const seed = new DatabaseSync(replacement);
  seed.exec("CREATE TABLE other (id INTEGER PRIMARY KEY)");
  seed.close();
  renameSync(replacement, path);

  assert.throws(
    () => connection.db.prepare("SELECT COUNT(*) AS count FROM items").get(),
    (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        GSD_STALE_STATE,
        `expected GSD_STALE_STATE, got ${String(error)}`,
      );
      assert.match(String(error), /detached from its path/);
      return true;
    },
  );
});
