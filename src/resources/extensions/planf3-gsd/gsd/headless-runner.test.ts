import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GsdRunner, parseJsonLines, type Spawner } from "./headless-runner.js";

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

  // C1: exit code 1 with stderr error — does NOT throw
  test("accepts exit code 1 (error) without throwing, returns result", async () => {
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 1, stdout: "", stderr: "some gsd error" }) });
    const result = await runner.query();
    assert.equal(result.exitCode, 1);
  });

  // C1: exit code 11 (cancelled) — does NOT throw
  test("accepts exit code 11 (cancelled) without throwing, returns result", async () => {
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 11, stdout: "", stderr: "" }) });
    const result = await runner.query();
    assert.equal(result.exitCode, 11);
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

describe("GsdRunner.auto", () => {
  test("invokes headless auto with json output format", async () => {
    const captured: { cmd: string; args: string[]; }[] = [];
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 0, stdout: "{}", stderr: "" }, captured) });
    await runner.auto();
    assert.deepEqual(captured[0].args, ["headless", "--output-format", "json", "auto"]);
  });
});

describe("GsdRunner timeoutSeconds", () => {
  test("inserts --timeout for new-milestone and auto, never for query", async () => {
    const captured: { cmd: string; args: string[]; }[] = [];
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", timeoutSeconds: 0, spawn: fakeSpawner({ exitCode: 0, stdout: "{}", stderr: "" }, captured) });

    await runner.newMilestone("specs/x.gsd.md", { auto: true });
    assert.deepEqual(captured[0].args, ["headless", "--output-format", "json", "--timeout", "0", "new-milestone", "--context", "specs/x.gsd.md", "--auto"]);

    await runner.auto();
    assert.deepEqual(captured[1].args, ["headless", "--output-format", "json", "--timeout", "0", "auto"]);

    await runner.query();
    assert.deepEqual(captured[2].args, ["headless", "--output-format", "json", "query"]);
  });
});

describe("GsdRunner onStdout forwarding (F4 / #1294 guard)", () => {
  test("newMilestone forwards onStdout to the spawner opts, invoked once per chunk", async () => {
    const chunks: string[] = [];
    const spawn: Spawner = async (_cmd, _args, opts) => {
      opts.onStdout?.("chunk-a");
      opts.onStdout?.("chunk-b");
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn });
    await runner.newMilestone("specs/x.gsd.md", { onStdout: (c) => chunks.push(c) });
    assert.deepEqual(chunks, ["chunk-a", "chunk-b"]);
  });

  test("auto forwards onStdout to the spawner opts", async () => {
    const chunks: string[] = [];
    const spawn: Spawner = async (_cmd, _args, opts) => {
      opts.onStdout?.("progress\n");
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn });
    await runner.auto({ onStdout: (c) => chunks.push(c) });
    assert.deepEqual(chunks, ["progress\n"]);
  });

  test("absent onStdout does not throw — existing callers are unaffected", async () => {
    const runner = new GsdRunner({ binary: "gsd", cwd: "/tmp", spawn: fakeSpawner({ exitCode: 0, stdout: "{}", stderr: "" }) });
    await runner.newMilestone("specs/x.gsd.md");
    await runner.auto();
  });
});

describe("parseJsonLines", () => {
  // A2: parses N JSONL lines
  test("returns N parsed values for N-line JSONL stdout", () => {
    const line1 = { type: "progress", pct: 0.1 };
    const line2 = { type: "progress", pct: 0.5 };
    const line3 = { type: "done", result: "ok" };
    const stdout = [JSON.stringify(line1), JSON.stringify(line2), JSON.stringify(line3)].join("\n") + "\n";
    const result = parseJsonLines(stdout);
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], line1);
    assert.deepEqual(result[1], line2);
    assert.deepEqual(result[2], line3);
  });

  // A2: skips non-JSON line without failing
  test("skips a non-JSON line in the middle without failing", () => {
    const line1 = { type: "start" };
    const line3 = { type: "end" };
    const stdout = [JSON.stringify(line1), "[headless] noise line", JSON.stringify(line3)].join("\n");
    const result = parseJsonLines(stdout);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], line1);
    assert.deepEqual(result[1], line3);
  });
});

describe("control subcommands (M4)", () => {
  const capture = (): { spawn: Spawner; calls: string[][] } => {
    const calls: string[][] = [];
    const spawn: Spawner = async (_cmd, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    return { spawn, calls };
  };

  test("steer passes the instruction as one argv token", async () => {
    const { spawn, calls } = capture();
    await new GsdRunner({ cwd: "/tmp", spawn }).steer("focus on the parser tests");
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "steer", "focus on the parser tests"]);
  });

  test("pause and stop are bare subcommands", async () => {
    const { spawn, calls } = capture();
    const r = new GsdRunner({ cwd: "/tmp", spawn });
    await r.pause();
    await r.stop();
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "pause"]);
    assert.deepEqual(calls[1], ["headless", "--output-format", "json", "stop"]);
  });

  test("next uses the long-run prefix (carries --timeout when configured)", async () => {
    const { spawn, calls } = capture();
    await new GsdRunner({ cwd: "/tmp", spawn, timeoutSeconds: 0 }).next();
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "--timeout", "0", "next"]);
  });
});
