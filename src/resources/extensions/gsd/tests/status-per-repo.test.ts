/**
 * status-per-repo.test.ts — `/gsd status` per-repository git-health block (#818).
 *
 * Covers the parent-workspace addition to formatTextStatus:
 *   - parent mode with child repos → "Repositories:" section listing each
 *   - dirty vs clean markers
 *   - single-repo (project-mode) project → no Repositories section
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { formatTextStatus } from "../commands/handlers/core.ts";
import type { GSDState } from "../types.ts";

function gitInit(cwd: string): void {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
}

function makeBaseState(): GSDState {
  return {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "None",
    registry: [],
  };
}

function writeParentPrefs(base: string, repos: Record<string, { path: string; role?: string }>): void {
  const repoLines = Object.entries(repos)
    .map(([id, cfg]) => `    ${id}:\n      path: ${cfg.path}${cfg.role ? `\n      role: ${cfg.role}` : ""}`)
    .join("\n");
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    `---\nversion: 1\nworkspace:\n  mode: parent\n  repositories:\n${repoLines}\n---\n`,
    "utf-8",
  );
}

test("formatTextStatus shows a Repositories section for a clean parent workspace", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-status-repo-clean-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    gitInit(base);
    mkdirSync(join(base, "frontend"), { recursive: true });
    gitInit(join(base, "frontend"));
    writeParentPrefs(base, { frontend: { path: "frontend", role: "web UI" } });

    const out = formatTextStatus(makeBaseState(), base);
    assert.match(out, /Repositories:/);
    assert.match(out, /✓ frontend — web UI \(clean\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("formatTextStatus marks a dirty child repo with ✗", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-status-repo-dirty-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    gitInit(base);
    mkdirSync(join(base, "backend"), { recursive: true });
    gitInit(join(base, "backend"));
    writeParentPrefs(base, { backend: { path: "backend" } });
    // Make the backend repo dirty.
    writeFileSync(join(base, "backend", "README.md"), "# dirty\n", "utf-8");

    const out = formatTextStatus(makeBaseState(), base);
    assert.match(out, /✗ backend \(uncommitted changes\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("formatTextStatus omits the Repositories section for single-repo projects", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-status-repo-single-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    gitInit(base);
    // No workspace config → project mode (default).
    const out = formatTextStatus(makeBaseState(), base);
    assert.doesNotMatch(out, /Repositories:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
