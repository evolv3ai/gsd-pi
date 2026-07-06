// Project/App: gsd-pi
// File Purpose: Tests closeout git action deferral policy for auto-mode units.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { postUnitPreVerification, shouldDeferCloseoutGitAction, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, insertVerificationEvidence, openDatabase } from "../gsd-db.ts";
import { recordToolCall, recordToolResult, resetEvidence } from "../safety/evidence-collector.ts";
import { cleanup, git, makeTempRepo } from "./test-utils.ts";

test("execute-task defers closeout git action until verification passes", () => {
  assert.equal(shouldDeferCloseoutGitAction("execute-task"), true);
});

test("non execute-task units keep pre-verification closeout git action", () => {
  assert.equal(shouldDeferCloseoutGitAction("plan-slice"), false);
  assert.equal(shouldDeferCloseoutGitAction("complete-slice"), false);
});

test("blocking evidence-xref commits deferred execute-task work before pausing", async () => {
  const base = makeTempRepo("gsd-evidence-xref-commit-before-pause-");

  try {
    writeFileSync(join(base, ".gitignore"), ".gsd/\n");
    git(base, "add", ".gitignore");
    git(base, "commit", "-m", "chore: ignore gsd runtime");

    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Add app entrypoint",
      status: "complete",
      oneLiner: "Added app entrypoint",
      keyFiles: ["app.js"],
      planning: {
        description: "Create app entrypoint",
        estimate: "small",
        files: ["app.js"],
        verify: "npm test",
        inputs: [],
        expectedOutput: ["app.js"],
        observabilityImpact: "none",
      },
    });
    insertVerificationEvidence({
      taskId: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      command: "npm test",
      exitCode: 0,
      verdict: "passed",
      durationMs: 10,
    });

    writeFileSync(join(base, "app.js"), "console.log('ready');\n");
    resetEvidence();
    recordToolCall("call-1", "bash", { command: "npm test" });
    recordToolResult("call-1", "bash", "Command exited with code 1\nfailed\n", true);

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.canonicalProjectRoot = base;
    s.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };

    let pauseCalled = false;
    const notifications: string[] = [];
    const pctx: PostUnitContext = {
      s,
      ctx: {
        ui: { notify: (message: string) => notifications.push(message) },
      } as PostUnitContext["ctx"],
      pi: {} as PostUnitContext["pi"],
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => {
        pauseCalled = true;
        assert.equal(git(base, "status", "--short"), "", "task work must be committed before pauseAuto runs");
      },
      updateProgressWidget: () => {},
    };

    const result = await postUnitPreVerification(pctx, {
      skipSettleDelay: true,
      skipWorktreeSync: true,
    });

    assert.equal(result, "dispatched");
    assert.equal(pauseCalled, true);
    assert.ok(
      notifications.some((message) => message.includes("claimed passing verification")),
      `expected evidence-xref notification, got: ${notifications.join("\n")}`,
    );

    const commitMessage = git(base, "log", "-1", "--pretty=%B");
    assert.match(commitMessage, /^feat: Added app entrypoint/m);
    assert.match(commitMessage, /GSD-Task: S01\/T01/);
  } finally {
    resetEvidence();
    closeDatabase();
    cleanup(base);
  }
});
