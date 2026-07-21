// gsd-pi — regression tests for the gsd migrate staging path-escape guards.
//
// relative(generatedGsd, realSource) returns exactly ".." (no trailing slash)
// when the source realpath is the parent of the generated .gsd directory. A
// startsWith("../") check misses that form and join(stagingRoot, "..") then
// escapes the staging root.

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyVerifiedMigrationApplication } from "../db-workspace.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";

function makeProject(t: test.TestContext): { root: string; gsd: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-escape-")));
  const gsd = join(root, ".gsd");
  mkdirSync(gsd, { recursive: true });
  t.after(() => {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, gsd };
}

function stagingResidue(root: string): string[] {
  return readdirSync(root).filter((entry) => entry.startsWith(".gsd-migration-import-"));
}

test("gsd migrate rejects a source that resolves to the parent of the generated .gsd directory", (t) => {
  const { root } = makeProject(t);

  // realpath(source) === project root, so relative(generatedGsd, source) is
  // exactly ".." — previously not caught because it has no trailing slash.
  assert.throws(
    () => applyVerifiedMigrationApplication(root, [root]),
    /escaped the generated \.gsd directory/,
  );
  assert.deepEqual(stagingResidue(root), [], "staging root must be cleaned up");
  assert.equal(existsSync(join(root, "state-manifest.json")), false);
});

test("gsd migrate rejects a retained artifact whose realpath escapes the generated .gsd directory", (t) => {
  const { root, gsd } = makeProject(t);
  assert.equal(openDatabase(join(gsd, "gsd.db")), true);
  const keepPath = join(gsd, "keep.md");
  writeFileSync(keepPath, "# keep\n");

  // logicalPath ".." resolves to the project root: previously the identity
  // comparison logicalPath === artifact.logicalPath let it through and the
  // startsWith("../") guard missed the exact ".." form.
  assert.throws(
    () => applyVerifiedMigrationApplication(root, [keepPath], gsd, undefined, [
      { logicalPath: "..", sha256: `sha256:${"0".repeat(64)}` },
    ]),
    /escaped the retained projection/,
  );
  assert.deepEqual(stagingResidue(root), [], "staging root must be cleaned up");
});

test("gsd migrate still rejects deep escapes with a trailing-slash relative form", (t) => {
  const { root, gsd } = makeProject(t);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-outside-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "outside.md");
  writeFileSync(outsideFile, "# outside\n");

  assert.throws(
    () => applyVerifiedMigrationApplication(root, [outsideFile], gsd),
    /escaped the generated \.gsd directory/,
  );
  assert.deepEqual(stagingResidue(root), [], "staging root must be cleaned up");
});
