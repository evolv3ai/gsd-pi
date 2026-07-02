/**
 * doctor-workspace.test.ts — Parent-workspace declared-repository probe (#818).
 *
 * Covers:
 *   - declared child repo path missing on disk → workspace_repo_path_missing
 *   - declared child repo path exists but is not a git repo → workspace_repo_not_a_repo
 *   - valid child repos → no workspace issues
 *   - single-repo (project-mode) project → probe is a no-op
 *   - non-git parent root is handled gracefully (the common layout)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runGSDDoctor } from "../doctor.ts";

function gitInit(cwd: string): void {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
}

function writeParentPrefs(base: string, repos: Record<string, { path: string }>): void {
  const repoLines = Object.entries(repos)
    .map(([id, cfg]) => `    ${id}:\n      path: ${cfg.path}`)
    .join("\n");
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    `---\nversion: 1\nworkspace:\n  mode: parent\n  repositories:\n${repoLines}\n---\n`,
    "utf-8",
  );
}

test("doctor flags a declared child repo whose path is missing on disk", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-ws-missing-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    gitInit(base);
    // `frontend` is declared but never created on disk.
    writeParentPrefs(base, { frontend: { path: "frontend" } });

    const report = await runGSDDoctor(base);
    const issue = report.issues.find((i) => i.code === "workspace_repo_path_missing");
    assert.ok(issue, "expected a workspace_repo_path_missing issue");
    assert.equal(issue?.unitId, "workspace.repositories.frontend");
    assert.match(issue?.message ?? "", /does not exist on disk/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("doctor flags a declared child repo path that is not a git repository", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-ws-notrepo-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    gitInit(base);
    // `backend` exists as a plain directory but is not a git repo.
    mkdirSync(join(base, "backend"), { recursive: true });
    writeParentPrefs(base, { backend: { path: "backend" } });

    const report = await runGSDDoctor(base);
    const issue = report.issues.find((i) => i.code === "workspace_repo_not_a_repo");
    assert.ok(issue, "expected a workspace_repo_not_a_repo issue");
    assert.equal(issue?.unitId, "workspace.repositories.backend");
    assert.match(issue?.message ?? "", /not a git repository/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("doctor reports no workspace issues when declared child repos are valid", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-ws-valid-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    gitInit(base);
    mkdirSync(join(base, "frontend"), { recursive: true });
    gitInit(join(base, "frontend"));
    writeParentPrefs(base, { frontend: { path: "frontend" } });

    const report = await runGSDDoctor(base);
    const wsIssues = report.issues.filter(
      (i) => i.code === "workspace_repo_path_missing" || i.code === "workspace_repo_not_a_repo",
    );
    assert.deepEqual(wsIssues, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("doctor workspace probe is a no-op for single-repo (project-mode) projects", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-ws-noproj-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    gitInit(base);
    // No workspace config → project mode (default).
    const report = await runGSDDoctor(base);
    const wsIssues = report.issues.filter(
      (i) => i.code === "workspace_repo_path_missing" || i.code === "workspace_repo_not_a_repo",
    );
    assert.deepEqual(wsIssues, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("doctor runs cleanly when the parent root is itself not a git repo (common layout)", async () => {
  // Regression guard (#818 cross-cutting): a parent folder holding child git
  // repos need not be a git repo itself. Doctor must not crash and must not
  // treat the parent as a missing/non-repo child.
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-ws-nongitparent-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    // NOTE: no gitInit(base) — parent is a plain folder.
    mkdirSync(join(base, "frontend"), { recursive: true });
    gitInit(join(base, "frontend"));
    writeParentPrefs(base, { frontend: { path: "frontend" } });

    const report = await runGSDDoctor(base);
    // The declared child repo is valid; the non-git parent must not produce a
    // child-repo issue or crash the run.
    const wsIssues = report.issues.filter(
      (i) => i.code === "workspace_repo_path_missing" || i.code === "workspace_repo_not_a_repo",
    );
    assert.deepEqual(wsIssues, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
