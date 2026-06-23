import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runStatus } from "./status.js";
import type { Spawner } from "../gsd/headless-runner.js";

describe("runStatus", () => {
  test("returns mapped status from query", async () => {
    const spawn: Spawner = async (_cmd, args) => {
      assert.deepEqual(args, ["headless", "--output-format", "json", "query"]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: {
            phase: "executing",
            activeMilestone: { id: "M001", title: "Bootstrap" },
            progress: { milestones: { done: 0, total: 1 }, slices: { done: 0, total: 3 }, tasks: { done: 0, total: 7 } },
          },
          next: { action: "dispatch" },
          cost: { workers: [], total: 1.25 },
        }),
        stderr: "[headless] noise",
      };
    };
    const status = await runStatus({ binary: "gsd", cwd: "/tmp", spawn });
    assert.equal(status.phase, "executing");
    assert.equal(status.activeMilestone?.id, "M001");
    assert.equal(status.cost, 1.25);
    assert.deepEqual(status.progress?.tasks, { done: 0, total: 7 });
  });
});
