// gsd-pi — DB writability probe regression tests (#1234).
//
// Auto-start's DB gate only checked that the provider opened, not that the
// handle can actually write. A schema-current DB does zero writes during open,
// so a read-only / DBMOVED handle passed the open-only check and failed much
// later at the first authoritative write with an opaque "readonly database"
// error. `probeDbWritable` forces a real page write so that failure class is
// caught at the natural checkpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase, probeDbWritable, _getAdapter } from "../gsd-db.ts";
import type { DbAdapter } from "../db-adapter.ts";

function makeBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-db-writable-probe-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

test("probeDbWritable succeeds against a freshly opened writable database", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  try {
    assert.deepEqual(probeDbWritable(), { ok: true });
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("probeDbWritable reports not-ok with detail when no database is open", () => {
  closeDatabase();
  const result = probeDbWritable();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /No database is open/u);
});

test("probeDbWritable reports not-ok when the page write fails (simulating a read-only handle)", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const adapter = _getAdapter() as DbAdapter;
  assert.ok(adapter);

  // The read (prepare/get) still works; only the page-dirtying write throws,
  // mirroring SQLITE_READONLY_DBMOVED which fails once a page is dirtied.
  const origExec = adapter.exec.bind(adapter);
  adapter.exec = (sql: string): void => {
    if (sql.includes("user_version =")) throw new Error("attempt to write a readonly database");
    return origExec(sql);
  };

  try {
    const result = probeDbWritable();
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /readonly database/u);
  } finally {
    adapter.exec = origExec;
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
