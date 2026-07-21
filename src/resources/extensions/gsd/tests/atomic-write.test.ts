import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atomicWriteAsyncWithOps,
  atomicWriteSyncWithOps,
  type AtomicWriteAsyncOps,
  type AtomicWriteSyncOps,
} from "../atomic-write.ts";

function makeError(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function createAsyncHarness(plan: Array<Error | null>) {
  const files = new Map<string, string>();
  const renameCalls: Array<{ from: string; to: string }> = [];
  const unlinkCalls: string[] = [];
  const sleepCalls: number[] = [];
  let tempCounter = 0;

  const ops: AtomicWriteAsyncOps = {
    mkdir: async () => {},
    writeFile: async (path, content) => {
      files.set(path, String(content));
    },
    rename: async (from, to) => {
      renameCalls.push({ from, to });
      const outcome = plan.shift() ?? null;
      if (outcome) throw outcome;
      const content = files.get(from);
      if (content === undefined) throw makeError("ENOENT", "temp missing");
      files.set(to, content);
      files.delete(from);
    },
    unlink: async (path) => {
      unlinkCalls.push(path);
      files.delete(path);
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`,
  };

  return { ops, files, renameCalls, unlinkCalls, sleepCalls };
}

function createSyncHarness(plan: Array<Error | null>) {
  const files = new Map<string, string>();
  const renameCalls: Array<{ from: string; to: string }> = [];
  const unlinkCalls: string[] = [];
  const sleepCalls: number[] = [];
  let tempCounter = 0;

  const ops: AtomicWriteSyncOps = {
    mkdir: () => {},
    writeFile: (path, content) => {
      files.set(path, String(content));
    },
    rename: (from, to) => {
      renameCalls.push({ from, to });
      const outcome = plan.shift() ?? null;
      if (outcome) throw outcome;
      const content = files.get(from);
      if (content === undefined) throw makeError("ENOENT", "temp missing");
      files.set(to, content);
      files.delete(from);
    },
    unlink: (path) => {
      unlinkCalls.push(path);
      files.delete(path);
    },
    sleep: (ms) => {
      sleepCalls.push(ms);
    },
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`,
  };

  return { ops, files, renameCalls, unlinkCalls, sleepCalls };
}

test("atomicWriteAsync retries transient rename failures and preserves atomicity", async () => {
  const harness = createAsyncHarness([makeError("EBUSY"), makeError("EPERM"), null]);
  harness.files.set("C:/tmp/output.txt", "old-content");

  await atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops);

  assert.equal(harness.renameCalls.length, 3);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "new-content");
  assert.equal(harness.unlinkCalls.length, 0);
  assert.equal(harness.sleepCalls.length, 2);
});

test("atomicWriteAsync cleans up temp file and reports attempts after repeated transient failures", async () => {
  const harness = createAsyncHarness([
    makeError("EACCES"),
    makeError("EBUSY"),
    makeError("EPERM"),
    makeError("EACCES"),
    makeError("EBUSY"),
  ]);
  harness.files.set("C:/tmp/output.txt", "old-content");

  await assert.rejects(
    atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops),
    (error: unknown) => {
      assert.match(String(error), /C:\\\/tmp\/output\.txt|C:\/tmp\/output\.txt/);
      assert.match(String(error), /attempt/i);
      assert.match(String(error), /EBUSY|EPERM|EACCES/);
      return true;
    },
  );

  assert.equal(harness.renameCalls.length, 5);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "old-content");
  assert.equal(harness.unlinkCalls.length, 1);
});

test("atomicWriteAsync does not retry non-transient rename failures", async () => {
  const harness = createAsyncHarness([makeError("ENOENT")]);
  harness.files.set("C:/tmp/output.txt", "old-content");

  await assert.rejects(() => atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops));

  assert.equal(harness.renameCalls.length, 1);
  assert.equal(harness.sleepCalls.length, 0);
  assert.equal(harness.unlinkCalls.length, 1);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "old-content");
});

test("atomicWriteSync retries transient rename failures and succeeds", () => {
  const harness = createSyncHarness([makeError("EACCES"), makeError("EBUSY"), null]);
  harness.files.set("C:/tmp/output.txt", "old-content");

  atomicWriteSyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops);

  assert.equal(harness.renameCalls.length, 3);
  assert.equal(harness.sleepCalls.length, 2);
  assert.equal(harness.unlinkCalls.length, 0);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "new-content");
});

test("managed projection writes fall back when the pinned native engine lacks identity locks", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-atomic-native-fallback-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  writeFileSync(join(gsd, "gsd.db"), "database-present");
  const output = join(gsd, "STATE.md");
  const moduleUrl = new URL("../atomic-write.ts", import.meta.url).href;
  const loaderPath = new URL("./resolve-ts.mjs", import.meta.url).pathname;
  const script = `
    const { atomicWriteSync } = await import(${JSON.stringify(moduleUrl)});
    atomicWriteSync(process.argv[1], "fallback-content");
  `;

  const result = spawnSync(process.execPath, [
    "--import", loaderPath,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval", script,
    output,
  ], {
    encoding: "utf8",
    env: { ...process.env, GSD_NATIVE_DISABLE: "1" },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(output, "utf8"), "fallback-content");
});

test("copyProjectionFileSync falls back when the pinned native engine lacks identity locks", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-copy-native-fallback-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  writeFileSync(join(gsd, "gsd.db"), "database-present");
  const source = join(gsd, "DECISIONS.md");
  const output = join(base, "worktree", ".gsd", "DECISIONS.md");
  const moduleUrl = new URL("../atomic-write.ts", import.meta.url).href;
  const loaderPath = new URL("./resolve-ts.mjs", import.meta.url).pathname;
  const script = `
    const { copyProjectionFileSync } = await import(${JSON.stringify(moduleUrl)});
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.argv[1], "decisions-content");
    copyProjectionFileSync(process.argv[1], process.argv[2], false);
  `;

  const result = spawnSync(process.execPath, [
    "--import", loaderPath,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval", script,
    source,
    output,
  ], {
    encoding: "utf8",
    env: { ...process.env, GSD_NATIVE_DISABLE: "1" },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(output, "utf8"), "decisions-content");
});

test("mergeProjectionTreeSync falls back when the pinned native engine lacks identity locks", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-merge-native-fallback-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  writeFileSync(join(gsd, "gsd.db"), "database-present");
  const sourceTree = join(gsd, "phases", "22-m022");
  const targetTree = join(base, "worktree", ".gsd", "phases", "22-m022");
  const moduleUrl = new URL("../atomic-write.ts", import.meta.url).href;
  const loaderPath = new URL("./resolve-ts.mjs", import.meta.url).pathname;
  const script = `
    const { mergeProjectionTreeSync } = await import(${JSON.stringify(moduleUrl)});
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(process.argv[1], "slices", "S01"), { recursive: true });
    writeFileSync(join(process.argv[1], "22-CONTEXT.md"), "context-content");
    writeFileSync(join(process.argv[1], "slices", "S01", "S01-PLAN.md"), "plan-content");
    mkdirSync(process.argv[2], { recursive: true });
    writeFileSync(join(process.argv[2], "22-CONTEXT.md"), "worktree-local-content");
    mergeProjectionTreeSync(process.argv[1], process.argv[2], false);
  `;

  const result = spawnSync(process.execPath, [
    "--import", loaderPath,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval", script,
    sourceTree,
    targetTree,
  ], {
    encoding: "utf8",
    env: { ...process.env, GSD_NATIVE_DISABLE: "1" },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  // Additive semantics preserved: nested files are copied, existing
  // worktree-local files are not clobbered by the merge (#1886).
  assert.equal(
    readFileSync(join(targetTree, "slices", "S01", "S01-PLAN.md"), "utf8"),
    "plan-content",
  );
  assert.equal(
    readFileSync(join(targetTree, "22-CONTEXT.md"), "utf8"),
    "worktree-local-content",
  );
});

test("projection tree fallback rejects symlink entries instead of silently skipping them", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-merge-symlink-reject-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const gsd = join(base, ".gsd");
  mkdirSync(gsd);
  writeFileSync(join(gsd, "gsd.db"), "database-present");
  const sourceTree = join(gsd, "phases", "22-m022");
  const targetTree = join(base, "worktree", ".gsd", "phases", "22-m022");
  const outsideSecret = join(base, "outside-secret.md");
  const moduleUrl = new URL("../atomic-write.ts", import.meta.url).href;
  const loaderPath = new URL("./resolve-ts.mjs", import.meta.url).pathname;
  const script = `
    const { mergeProjectionTreeSync } = await import(${JSON.stringify(moduleUrl)});
    const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(process.argv[1], { recursive: true });
    writeFileSync(join(process.argv[1], "22-CONTEXT.md"), "context-content");
    // A symlink pointing outside the source root: the native identity lock's
    // pathKind rejects it, so the plain-fs fallback must throw too rather than
    // skip it and leave a partial projection.
    writeFileSync(process.argv[3], "secret-outside-root");
    symlinkSync(process.argv[3], join(process.argv[1], "escape.md"));
    mergeProjectionTreeSync(process.argv[1], process.argv[2], false);
  `;

  const result = spawnSync(process.execPath, [
    "--import", loaderPath,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval", script,
    sourceTree,
    targetTree,
    outsideSecret,
  ], {
    encoding: "utf8",
    env: { ...process.env, GSD_NATIVE_DISABLE: "1" },
  });

  assert.notEqual(result.status, 0, "expected the symlink entry to be rejected");
  assert.match(result.stderr, /neither a regular file nor a directory/);
  // The symlink target's content must never reach the projection target.
  assert.equal(existsSync(join(targetTree, "escape.md")), false);
});

// ─── Durability: fsync ordering in the fallback WithOps paths ────────────────

function createFsyncSyncHarness(plan: Array<Error | null> = []) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let tempCounter = 0;

  const ops: AtomicWriteSyncOps = {
    mkdir: () => {},
    writeFile: (path, content) => {
      files.set(path, String(content));
    },
    rename: (from, to) => {
      calls.push(`rename:${from}`);
      const outcome = plan.shift() ?? null;
      if (outcome) throw outcome;
      const content = files.get(from);
      if (content === undefined) throw makeError("ENOENT", "temp missing");
      files.set(to, content);
      files.delete(from);
    },
    unlink: (path) => {
      files.delete(path);
    },
    sleep: () => {},
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`,
    fsyncFile: (path) => {
      calls.push(`fsyncFile:${path}`);
    },
    fsyncDirectory: (path) => {
      calls.push(`fsyncDirectory:${path}`);
    },
  };

  return { ops, files, calls };
}

function createFsyncAsyncHarness(plan: Array<Error | null> = []) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let tempCounter = 0;

  const ops: AtomicWriteAsyncOps = {
    mkdir: async () => {},
    writeFile: async (path, content) => {
      files.set(path, String(content));
    },
    rename: async (from, to) => {
      calls.push(`rename:${from}`);
      const outcome = plan.shift() ?? null;
      if (outcome) throw outcome;
      const content = files.get(from);
      if (content === undefined) throw makeError("ENOENT", "temp missing");
      files.set(to, content);
      files.delete(from);
    },
    unlink: async (path) => {
      files.delete(path);
    },
    sleep: async () => {},
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`,
    fsyncFile: async (path) => {
      calls.push(`fsyncFile:${path}`);
    },
    fsyncDirectory: async (path) => {
      calls.push(`fsyncDirectory:${path}`);
    },
  };

  return { ops, files, calls };
}

test("atomicWriteSync fsyncs the temp file before rename and the directory after rename", () => {
  const harness = createFsyncSyncHarness();

  atomicWriteSyncWithOps("/data/output.txt", "durable", "utf-8", harness.ops);

  assert.deepEqual(harness.calls, [
    "fsyncFile:/data/output.txt.tmp.test-1",
    "rename:/data/output.txt.tmp.test-1",
    "fsyncDirectory:/data",
  ]);
  assert.equal(harness.files.get("/data/output.txt"), "durable");
});

test("atomicWriteAsync fsyncs the temp file before rename and the directory after rename", async () => {
  const harness = createFsyncAsyncHarness();

  await atomicWriteAsyncWithOps("/data/output.txt", "durable", "utf-8", harness.ops);

  assert.deepEqual(harness.calls, [
    "fsyncFile:/data/output.txt.tmp.test-1",
    "rename:/data/output.txt.tmp.test-1",
    "fsyncDirectory:/data",
  ]);
  assert.equal(harness.files.get("/data/output.txt"), "durable");
});

test("atomicWriteSync fsyncs the temp once and the directory once after a retried rename", () => {
  const harness = createFsyncSyncHarness([makeError("EBUSY"), makeError("EPERM"), null]);

  atomicWriteSyncWithOps("/data/output.txt", "durable", "utf-8", harness.ops);

  const fsyncFileCalls = harness.calls.filter((call) => call.startsWith("fsyncFile:"));
  const fsyncDirectoryCalls = harness.calls.filter((call) => call.startsWith("fsyncDirectory:"));
  assert.deepEqual(fsyncFileCalls, ["fsyncFile:/data/output.txt.tmp.test-1"]);
  assert.deepEqual(fsyncDirectoryCalls, ["fsyncDirectory:/data"]);
  assert.equal(harness.calls[0], "fsyncFile:/data/output.txt.tmp.test-1");
  assert.equal(harness.calls.at(-1), "fsyncDirectory:/data");
  assert.equal(harness.files.get("/data/output.txt"), "durable");
});

test("atomicWriteSync aborts before any rename when the temp fsync fails", () => {
  const harness = createFsyncSyncHarness();
  const fsyncFailure = makeError("EIO", "fsync failed");
  harness.ops.fsyncFile = () => {
    throw fsyncFailure;
  };

  assert.throws(
    () => atomicWriteSyncWithOps("/data/output.txt", "durable", "utf-8", harness.ops),
    (error: unknown) => error === fsyncFailure,
  );
  assert.equal(harness.calls.some((call) => call.startsWith("rename:")), false);
  assert.equal(harness.files.has("/data/output.txt"), false);
});

test("atomicWriteAsync aborts before any rename when the temp fsync fails", async () => {
  const harness = createFsyncAsyncHarness();
  const fsyncFailure = makeError("EIO", "fsync failed");
  harness.ops.fsyncFile = async () => {
    throw fsyncFailure;
  };

  await assert.rejects(
    atomicWriteAsyncWithOps("/data/output.txt", "durable", "utf-8", harness.ops),
    (error: unknown) => error === fsyncFailure,
  );
  assert.equal(harness.calls.some((call) => call.startsWith("rename:")), false);
  assert.equal(harness.files.has("/data/output.txt"), false);
});
