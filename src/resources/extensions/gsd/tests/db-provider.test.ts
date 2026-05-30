// Project/App: gsd-pi
// File Purpose: Tests for SQLite provider loading and fallback behavior.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createSqliteProviderLoader, type SqliteProviderDeps } from "../db-provider.ts";

class FakeNodeDatabase {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }
}

class FakeBetterDatabase {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }
}

function createDeps(overrides: Partial<SqliteProviderDeps> = {}): SqliteProviderDeps & { stderr: string[] } {
  const stderr: string[] = [];
  return {
    tryRequireNodeSqlite(): unknown {
      return { DatabaseSync: FakeNodeDatabase };
    },
    tryRequireBetterSqlite3(): unknown {
      throw new Error("better-sqlite3 unavailable");
    },
    suppressSqliteWarning(): void {},
    nodeVersion: "22.0.0",
    writeStderr(message: string): void {
      stderr.push(message);
    },
    stderr,
    ...overrides,
  };
}

describe("db-provider", () => {
  test("loads node:sqlite first and opens raw databases with it", () => {
    const loader = createSqliteProviderLoader(createDeps());

    const rawDb = loader.openRaw("/tmp/gsd-node.db");

    assert.equal(loader.getProviderName(), "node:sqlite");
    assert.ok(rawDb instanceof FakeNodeDatabase);
    assert.equal((rawDb as FakeNodeDatabase).path, "/tmp/gsd-node.db");
  });

  test("falls back to better-sqlite3 when node:sqlite is unavailable", () => {
    const loader = createSqliteProviderLoader(createDeps({
      tryRequireNodeSqlite(): unknown {
        throw new Error("node sqlite unavailable");
      },
      tryRequireBetterSqlite3(): unknown {
        return FakeBetterDatabase;
      },
    }));

    const rawDb = loader.openRaw("/tmp/gsd-better.db");

    assert.equal(loader.getProviderName(), "better-sqlite3");
    assert.ok(rawDb instanceof FakeBetterDatabase);
    assert.equal((rawDb as FakeBetterDatabase).path, "/tmp/gsd-better.db");
  });

  test("reports provider unavailability with a Node version hint below Node 22", () => {
    const deps = createDeps({
      tryRequireNodeSqlite(): unknown {
        throw new Error("unavailable");
      },
      tryRequireBetterSqlite3(): unknown {
        throw new Error("unavailable");
      },
      nodeVersion: "20.11.1",
    });
    const loader = createSqliteProviderLoader(deps);

    assert.equal(loader.openRaw("/tmp/gsd-none.db"), null);

    assert.equal(loader.getProviderName(), null);
    assert.equal(deps.stderr.length, 1);
    assert.match(deps.stderr[0], /No SQLite provider available/);
    assert.match(deps.stderr[0], /Node >= 22\.0\.0/);
  });

  test("opens better-sqlite3 fallback without committing it until requested", () => {
    const loader = createSqliteProviderLoader(createDeps({
      tryRequireNodeSqlite(): unknown {
        return { DatabaseSync: FakeNodeDatabase };
      },
      tryRequireBetterSqlite3(): unknown {
        return { default: FakeBetterDatabase };
      },
    }));

    loader.load();
    const fallback = loader.tryOpenBetterSqliteFallback("/tmp/gsd-fallback.db");

    assert.equal(loader.getProviderName(), "node:sqlite");
    assert.ok(fallback);
    assert.ok(fallback.rawDb instanceof FakeBetterDatabase);
    assert.equal((fallback.rawDb as FakeBetterDatabase).path, "/tmp/gsd-fallback.db");

    loader.commitFallback(fallback);
    assert.equal(loader.getProviderName(), "better-sqlite3");
  });
});
