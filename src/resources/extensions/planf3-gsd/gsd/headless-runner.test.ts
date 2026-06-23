import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GsdRunner, type Spawner } from "./headless-runner.ts";

function fakeSpawner(plan: { exitCode: number; stdout: string; stderr: string; }, captured: { cmd: string; args: string[]; }[] = []): Spawner {
  return async (cmd, args) => {
    captured.push({ cmd, args });
    return { exitCode: plan.exitCode, stdout: plan.stdout, stderr: plan.stderr };
  };
}

describe("GsdRunner.query", () => {
  test("passes --output-format json before query and parses stdout JSON", async () => {
    const captured: { cmd: string; args: string[]; }[] = [];
    const snapshot = { state: { phase: "executing", activeMilestone: { id: "M001", title: "x" } }, next: { action: "dispatch" }, cost: { total: 0 } };
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 0, stdout: JSON.stringify(snapshot) + "\n", stderr: "[headless] noise\n" }, captured) });

    const result = await runner.query();

    assert.deepEqual(captured[0].args.slice(0, 4), ["headless", "--output-format", "json", "query"]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.json, snapshot);
    assert.equal(result.stderr.includes("[headless]"), true);
  });

  test("ignores stderr when extracting JSON", async () => {
    const captured: { cmd: string; args: string[]; }[] = [];
    const snapshot = { state: { phase: "idle" }, next: null, cost: { total: 0 } };
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 0, stdout: JSON.stringify(snapshot), stderr: "[headless] this is not json\n" }, captured) });

    const result = await runner.query();
    assert.deepEqual(result.json, snapshot);
  });

  test("throws on unexpected exit code", async () => {
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 7, stdout: "", stderr: "boom" }) });
    await assert.rejects(() => runner.query(), /unexpected exit code 7/);
  });

  test("accepts blocked exit code 10 without throwing", async () => {
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 10, stdout: "{\"state\":{\"phase\":\"blocked\"},\"next\":null,\"cost\":{\"total\":0}}", stderr: "" }) });
    const result = await runner.query();
    assert.equal(result.exitCode, 10);
  });
});

describe("GsdRunner.newMilestone", () => {
  test("invokes new-milestone with --context and respects --auto", async () => {
    const captured: { cmd: string; args: string[]; }[] = [];
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 0, stdout: "{}", stderr: "" }, captured) });

    await runner.newMilestone("specs/x.gsd.md", { auto: false });
    assert.deepEqual(captured[0].args, ["headless", "--output-format", "json", "new-milestone", "--context", "specs/x.gsd.md"]);

    await runner.newMilestone("specs/x.gsd.md", { auto: true });
    assert.deepEqual(captured[1].args, ["headless", "--output-format", "json", "new-milestone", "--context", "specs/x.gsd.md", "--auto"]);
  });
});
