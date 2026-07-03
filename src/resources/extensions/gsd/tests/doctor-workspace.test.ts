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
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runGSDDoctor } from "../doctor.ts";
import { GIT_NO_PROMPT_ENV } from "../git-constants.ts";

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

test("doctor workspace git probe uses safe env and canonical toplevel comparison", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-only git shim regression");
    return;
  }

  const originalProcessGitDir = process.env.GIT_DIR;
  const originalProcessGitWorkTree = process.env.GIT_WORK_TREE;
  const originalGitEnvPath = GIT_NO_PROMPT_ENV.PATH;
  const originalGitEnvRealGit = GIT_NO_PROMPT_ENV.GSD_REAL_GIT;
  const originalGitEnvFakeCwd = GIT_NO_PROMPT_ENV.GSD_FAKE_TOPLEVEL_CWD;
  const originalGitEnvFakeToplevel = GIT_NO_PROMPT_ENV.GSD_FAKE_TOPLEVEL;
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-ws-safeenv-"));

  t.after(() => {
    if (originalProcessGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalProcessGitDir;
    if (originalProcessGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalProcessGitWorkTree;
    if (originalGitEnvPath === undefined) delete GIT_NO_PROMPT_ENV.PATH;
    else GIT_NO_PROMPT_ENV.PATH = originalGitEnvPath;
    if (originalGitEnvRealGit === undefined) delete GIT_NO_PROMPT_ENV.GSD_REAL_GIT;
    else GIT_NO_PROMPT_ENV.GSD_REAL_GIT = originalGitEnvRealGit;
    if (originalGitEnvFakeCwd === undefined) delete GIT_NO_PROMPT_ENV.GSD_FAKE_TOPLEVEL_CWD;
    else GIT_NO_PROMPT_ENV.GSD_FAKE_TOPLEVEL_CWD = originalGitEnvFakeCwd;
    if (originalGitEnvFakeToplevel === undefined) delete GIT_NO_PROMPT_ENV.GSD_FAKE_TOPLEVEL;
    else GIT_NO_PROMPT_ENV.GSD_FAKE_TOPLEVEL = originalGitEnvFakeToplevel;
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd"), { recursive: true });
  const realChild = join(base, "frontend-real");
  const linkedChild = join(base, "frontend");
  mkdirSync(realChild, { recursive: true });
  gitInit(realChild);
  symlinkSync(realChild, linkedChild, "dir");
  writeParentPrefs(base, { frontend: { path: "frontend" } });

  const shimDir = join(base, "bin");
  mkdirSync(shimDir, { recursive: true });
  const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
  const shim = join(shimDir, "git");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ -n \"${GIT_DIR:-}\" ] || [ -n \"${GIT_WORK_TREE:-}\" ]; then",
      "  echo \"leaked git env\" >&2",
      "  exit 97",
      "fi",
      "if [ \"${1:-}\" = \"rev-parse\" ] && [ \"${2:-}\" = \"--show-toplevel\" ] && [ \"$(pwd -P)\" = \"$GSD_FAKE_TOPLEVEL_CWD\" ]; then",
      "  printf '%s\\n' \"$GSD_FAKE_TOPLEVEL\"",
      "  exit 0",
      "fi",
      "exec \"$GSD_REAL_GIT\" \"$@\"",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(shim, 0o755);

  process.env.GIT_DIR = join(base, ".git");
  process.env.GIT_WORK_TREE = base;
  GIT_NO_PROMPT_ENV.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
  GIT_NO_PROMPT_ENV.GSD_REAL_GIT = realGit;
  GIT_NO_PROMPT_ENV.GSD_FAKE_TOPLEVEL_CWD = realChild;
  GIT_NO_PROMPT_ENV.GSD_FAKE_TOPLEVEL = linkedChild;

  const report = await runGSDDoctor(base);
  const wsIssues = report.issues.filter(
    (i) => i.code === "workspace_repo_path_missing" || i.code === "workspace_repo_not_a_repo",
  );
  assert.deepEqual(wsIssues, []);
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
