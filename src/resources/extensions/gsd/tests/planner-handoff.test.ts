import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GSD_COMMAND_DESCRIPTION, getGsdArgumentCompletions, TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.ts";
import { handleCoreCommand } from "../commands/handlers/core.ts";
import { DISPATCH_RULES } from "../auto-dispatch.ts";
import {
  buildGsdPlannerSpawnPlan,
  formatGsdPlannerCommand,
  hasPlannerHandoffBeenOffered,
  markPlannerHandoffOffered,
  PLANNER_HANDOFF_RULE_NAME,
} from "../planner-handoff.ts";

describe("planner handoff command catalog", () => {
  test("/gsd planner is hidden from description and completions", () => {
    assert.doesNotMatch(GSD_COMMAND_DESCRIPTION, /\|planner(?:\||$)/);
    assert.equal(
      TOP_LEVEL_SUBCOMMANDS.some((command) => command.cmd === "planner"),
      false,
      "planner should not appear in top-level commands",
    );

    const completions = getGsdArgumentCompletions("pla");

    assert.equal(
      completions.some((completion) => completion.value === "planner"),
      false,
      "planner should not appear in top-level completions",
    );

    assert.deepEqual(
      getGsdArgumentCompletions("planner --"),
      [],
      "planner should not expose nested completions",
    );
  });
});

describe("planner handoff command handler", () => {
  test("/gsd planner falls through to the unknown-command path", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
      },
    };

    const handled = await handleCoreCommand("planner M001 --dry-run --inspect", ctx as any);

    assert.equal(handled, false);
    assert.deepEqual(notifications, []);
  });
});

describe("planner handoff launcher", () => {
  test("builds gsd-planner command with project and milestone context", () => {
    const plan = buildGsdPlannerSpawnPlan({
      basePath: "/tmp/project with spaces",
      milestoneId: "M001",
      extraArgs: ["--inspect"],
    });

    assert.deepEqual(plan, {
      command: "gsd-planner",
      args: ["--project", "/tmp/project with spaces", "--milestone", "M001", "--inspect"],
      cwd: "/tmp/project with spaces",
    });
    assert.equal(
      formatGsdPlannerCommand(plan),
      'gsd-planner --project "/tmp/project with spaces" --milestone M001 --inspect',
    );
  });

  test("records one-shot handoff markers per milestone", () => {
    const basePath = mkdtempSync(join(tmpdir(), "gsd-planner-marker-"));
    try {
      assert.equal(hasPlannerHandoffBeenOffered(basePath, "M001"), false);
      markPlannerHandoffOffered(basePath, "M001");
      assert.equal(hasPlannerHandoffBeenOffered(basePath, "M001"), true);
      assert.equal(hasPlannerHandoffBeenOffered(basePath, "M002"), false);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
});

describe("planner handoff dispatch rule", () => {
  test("rule is not registered while /gsd planner is disabled", () => {
    assert.equal(
      DISPATCH_RULES.some((rule) => rule.name === PLANNER_HANDOFF_RULE_NAME),
      false,
    );
  });
});
