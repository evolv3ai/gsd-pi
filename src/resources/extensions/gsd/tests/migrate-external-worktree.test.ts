import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { migrateToExternalState, recoverFailedMigration } from "../migrate-external.ts";

function run(command: string, cwd: string): string {
  return execSync(command, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

describe("migrate-external worktree guard (#2970)", () => {
  let base: string;
  let stateDir: string;
  let worktreePath: string;

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-wt-")));
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-")));
    process.env.GSD_STATE_DIR = stateDir;

    // Create a git repo with a remote
    run("git init -b main", base);
    run('git config user.name "Test"', base);
    run('git config user.email "test@example.com"', base);
    run('git remote add origin git@github.com:example/repo.git', base);
    writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
    run("git add README.md", base);
    run('git commit -m "init"', base);

    // Create a worktree
    worktreePath = join(base, ".gsd", "worktrees", "M001");
    run(`git worktree add -b milestone/M001 ${worktreePath}`, base);

    // Populate worktree with a .gsd directory (simulating syncGsdStateToWorktree)
    const worktreeGsd = join(worktreePath, ".gsd");
    mkdirSync(worktreeGsd, { recursive: true });
    writeFileSync(join(worktreeGsd, "PREFERENCES.md"), "# prefs\n", "utf-8");
  });

  after(() => {
    delete process.env.GSD_STATE_DIR;
    // Remove worktree before cleaning up
    try { run(`git worktree remove --force ${worktreePath}`, base); } catch { /* ok */ }
    rmSync(base, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("migrateToExternalState skips when basePath is a git worktree", () => {
    // The worktree has a real .gsd directory — migration would normally run.
    // But since this is a worktree, it should be skipped.
    const result = migrateToExternalState(worktreePath);

    assert.equal(result.migrated, false, "should not migrate inside a worktree");
    assert.equal(result.error, undefined, "should not report an error");

    // .gsd should still exist as a real directory (not renamed/removed)
    assert.ok(
      existsSync(join(worktreePath, ".gsd")),
      ".gsd directory should still exist after skipped migration"
    );

    // .gsd.migrating should NOT exist
    assert.ok(
      !existsSync(join(worktreePath, ".gsd.migrating")),
      ".gsd.migrating should not be created in a worktree"
    );
  });

  test("migrateToExternalState does not leave .gsd.migrating on failed migration", () => {
    // Regression: #5571 — .gsd.migrating orphaned when cpSync succeeds but rmSync fails.
    // Here we verify the invariant: after migrateToExternalState returns migrated:false,
    // no .gsd.migrating exists in the worktree (which is always skipped by the guard).
    const result = migrateToExternalState(worktreePath);
    assert.equal(result.migrated, false);
    assert.ok(
      !existsSync(join(worktreePath, ".gsd.migrating")),
      ".gsd.migrating must not be left behind after a skipped/failed migration"
    );
  });

  test("migrateToExternalState still works on main repo", () => {
    // Create a fresh temp repo to test main repo migration path
    const mainBase = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-main-")));
    try {
      run("git init -b main", mainBase);
      run('git config user.name "Test"', mainBase);
      run('git config user.email "test@example.com"', mainBase);
      run('git remote add origin git@github.com:example/main-repo.git', mainBase);
      writeFileSync(join(mainBase, "README.md"), "# Test\n", "utf-8");
      run("git add README.md", mainBase);
      run('git commit -m "init"', mainBase);

      // Create a .gsd directory with content
      mkdirSync(join(mainBase, ".gsd"), { recursive: true });
      writeFileSync(join(mainBase, ".gsd", "PREFERENCES.md"), "# prefs\n", "utf-8");

      const result = migrateToExternalState(mainBase);
      assert.equal(result.migrated, true, "should migrate on main repo");
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
    }
  });
});

describe("migrateToExternalState rename fallback (#1179)", () => {
  test("falls back to copy/delete when rename fails with EACCES", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-eacces-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-eacces-")));
    const previousStateDir = process.env.GSD_STATE_DIR;
    const previousProjectId = process.env.GSD_PROJECT_ID;
    const originalRenameSync = fs.renameSync;
    const localGsd = join(base, ".gsd");
    const migratingPath = join(base, ".gsd.migrating");
    let renameAttempts = 0;

    process.env.GSD_STATE_DIR = stateDir;
    process.env.GSD_PROJECT_ID = "rename-eacces";

    try {
      run("git init -b main", base);
      mkdirSync(localGsd, { recursive: true });
      writeFileSync(join(localGsd, "PREFERENCES.md"), "# prefs\n", "utf-8");

      fs.renameSync = ((src, dst) => {
        if (String(src) === localGsd && String(dst) === migratingPath) {
          renameAttempts += 1;
          const error = new Error("simulated WSL/DrvFs rename lock") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalRenameSync(src, dst);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();

      const result = migrateToExternalState(base);

      assert.equal(result.migrated, true, "EACCES rename failure should use copy/delete fallback");
      assert.equal(result.error, undefined);
      assert.equal(renameAttempts, 1, "should exercise the EACCES rename fallback once");
      assert.equal(readFileSync(join(stateDir, "projects", "rename-eacces", "PREFERENCES.md"), "utf-8"), "# prefs\n");
      assert.equal(readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8"), "# prefs\n");
      assert.ok(!existsSync(migratingPath), "backup staging dir must be removed after successful migration");
    } finally {
      fs.renameSync = originalRenameSync;
      syncBuiltinESMExports();
      if (previousStateDir === undefined) {
        delete process.env.GSD_STATE_DIR;
      } else {
        process.env.GSD_STATE_DIR = previousStateDir;
      }
      if (previousProjectId === undefined) {
        delete process.env.GSD_PROJECT_ID;
      } else {
        process.env.GSD_PROJECT_ID = previousProjectId;
      }
      rmSync(base, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("migrateToExternalState copy failure rollback (#1047)", () => {
  test("restores .gsd when a source entry fails to copy", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-copy-fail-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-copy-fail-")));
    const previousStateDir = process.env.GSD_STATE_DIR;
    const previousProjectId = process.env.GSD_PROJECT_ID;
    const originalCpSync = fs.cpSync;
    process.env.GSD_STATE_DIR = stateDir;
    process.env.GSD_PROJECT_ID = "copy-fail";

    try {
      run("git init -b main", base);
      mkdirSync(join(base, ".gsd"), { recursive: true });
      writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "# prefs\n", "utf-8");
      writeFileSync(join(base, ".gsd", "gsd.db"), "state", "utf-8");
      const failingSource = join(base, ".gsd.migrating", "gsd.db");
      fs.cpSync = ((...args: Parameters<typeof fs.cpSync>) => {
        const src = args[0];
        if (String(src) === failingSource) {
          const error = new Error("simulated copy failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalCpSync(...args);
      }) as typeof fs.cpSync;
      syncBuiltinESMExports();

      const result = migrateToExternalState(base);

      assert.equal(result.migrated, false, "copy failure must fail the migration");
      assert.match(result.error ?? "", /Migration copy failed/);
      assert.ok(existsSync(join(base, ".gsd", "gsd.db")), "source .gsd must be restored");
      assert.equal(readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8"), "# prefs\n");
      assert.ok(!existsSync(join(base, ".gsd.migrating")), "backup staging dir must not remain after restore");
      assert.ok(!existsSync(join(stateDir, "projects", "copy-fail", "gsd.db")), "failed file must not be reported as migrated");
    } finally {
      fs.cpSync = originalCpSync;
      syncBuiltinESMExports();
      if (previousStateDir === undefined) {
        delete process.env.GSD_STATE_DIR;
      } else {
        process.env.GSD_STATE_DIR = previousStateDir;
      }
      if (previousProjectId === undefined) {
        delete process.env.GSD_PROJECT_ID;
      } else {
        process.env.GSD_PROJECT_ID = previousProjectId;
      }
      rmSync(base, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// Regression tests for #5571 — recoverFailedMigration handles orphaned .gsd.migrating
describe("recoverFailedMigration (#5571)", () => {
  test("returns false when .gsd.migrating does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-recover-"));
    try {
      const result = recoverFailedMigration(base);
      assert.equal(result, false, "should return false when no .gsd.migrating exists");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("returns false and leaves both dirs untouched when both .gsd and .gsd.migrating exist", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-recover-ambiguous-"));
    try {
      mkdirSync(join(base, ".gsd"), { recursive: true });
      mkdirSync(join(base, ".gsd.migrating"), { recursive: true });

      const result = recoverFailedMigration(base);
      assert.equal(result, false, "ambiguous state must not be auto-resolved");
      assert.ok(existsSync(join(base, ".gsd")), ".gsd should remain");
      assert.ok(existsSync(join(base, ".gsd.migrating")), ".gsd.migrating should remain");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("renames .gsd.migrating to .gsd and returns true when only .gsd.migrating exists", () => {
    // This is the primary recovery path for issue #5571:
    // cpSync succeeded (creating .gsd.migrating) but rmSync(localGsd) failed
    // (EPERM file lock). The fix now cleans up .gsd.migrating in that path,
    // but if cleanup also fails, recoverFailedMigration handles the next boot.
    const base = mkdtempSync(join(tmpdir(), "gsd-recover-rename-"));
    try {
      mkdirSync(join(base, ".gsd.migrating"), { recursive: true });
      writeFileSync(join(base, ".gsd.migrating", "PREFERENCES.md"), "# prefs\n", "utf-8");

      const result = recoverFailedMigration(base);
      assert.equal(result, true, "should rename .gsd.migrating to .gsd");
      assert.ok(existsSync(join(base, ".gsd")), ".gsd should exist after recovery");
      assert.ok(existsSync(join(base, ".gsd", "PREFERENCES.md")), "contents should be preserved");
      assert.ok(!existsSync(join(base, ".gsd.migrating")), ".gsd.migrating should be gone");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
