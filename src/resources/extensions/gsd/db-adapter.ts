// Project/App: gsd-pi
// File Purpose: Normalized SQLite adapter wrapper used by the GSD database facade.

export interface DbStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

export function normalizeDbRow(row: unknown): Record<string, unknown> | undefined {
  if (row == null) return undefined;
  if (Object.getPrototypeOf(row) === null) {
    return { ...(row as Record<string, unknown>) };
  }
  return row as Record<string, unknown>;
}

export function normalizeDbRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => normalizeDbRow(row)!);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// node:sqlite accepts binding-object keys with or without the ':'/'@'/'$'
// prefix, but better-sqlite3 accepts only bare keys — strip the prefix so
// call sites written against node:sqlite also work on the fallback provider.
function normalizeBindParams(params: unknown[]): unknown[] {
  return params.map((param) => {
    if (!isPlainObject(param)) return param;
    let changed = false;
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(param)) {
      if (key.length > 1 && (key[0] === ":" || key[0] === "@" || key[0] === "$")) {
        normalized[key.slice(1)] = value;
        changed = true;
      } else {
        normalized[key] = value;
      }
    }
    return changed ? normalized : param;
  });
}

export function createDbAdapter(rawDb: unknown): DbAdapter {
  const db = rawDb as {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
    close(): void;
  };

  const stmtCache = new Map<string, DbStatement>();

  function wrapStmt(raw: {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  }): DbStatement {
    return {
      run(...params: unknown[]): unknown {
        return raw.run(...normalizeBindParams(params));
      },
      get(...params: unknown[]): Record<string, unknown> | undefined {
        return normalizeDbRow(raw.get(...normalizeBindParams(params)));
      },
      all(...params: unknown[]): Record<string, unknown>[] {
        return normalizeDbRows(raw.all(...normalizeBindParams(params)));
      },
    };
  }

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): DbStatement {
      let cached = stmtCache.get(sql);
      if (cached) return cached;
      cached = wrapStmt(db.prepare(sql));
      stmtCache.set(sql, cached);
      return cached;
    },
    close(): void {
      stmtCache.clear();
      db.close();
    },
  };
}
