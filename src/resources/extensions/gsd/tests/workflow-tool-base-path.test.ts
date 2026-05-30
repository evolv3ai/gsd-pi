import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveWorkflowToolBasePath } from "../bootstrap/dynamic-tools.ts";
import { importWorkflowExecutorsModule } from "../workflow-mcp.ts";

test("resolveWorkflowToolBasePath routes milestone writes to auto-worktree", () => {
  const project = mkdtempSync(join(tmpdir(), "gsd-wt-base-"));
  const worktree = join(project, ".gsd", "worktrees", "M002-mskcfz");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: /tmp/fake-git-dir\n", "utf-8");

  try {
    const base = resolveWorkflowToolBasePath(
      { cwd: project },
      { milestone_id: "M002-mskcfz" },
    );
    assert.equal(base, worktree);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("importWorkflowExecutorsModule loads executeSummarySave", async () => {
  const mod = await importWorkflowExecutorsModule();
  assert.equal(typeof mod.executeSummarySave, "function");
});
