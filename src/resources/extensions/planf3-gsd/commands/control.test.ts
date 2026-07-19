import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSteer, runPause, runResume, runStop, CUSTODY_REMINDER } from "./control.js";
import type { Spawner } from "../gsd/headless-runner.js";

const NOW = () => "2026-07-19T12:00:00Z";

function capture(stdout = "{}"): { spawn: Spawner; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: Spawner = async (_cmd, args) => {
    calls.push(args);
    return { exitCode: 0, stdout, stderr: "" };
  };
  return { spawn, calls };
}

async function makeProject(mode: "auto" | "step" = "auto"): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-control-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  await writeFile(join(tmp, "specs", "p.html"), "<html></html>", "utf8");
  await writeFile(
    join(tmp, "specs", "p.manifest.json"),
    JSON.stringify({ planf3: { htmlPath: "specs/p.html" }, gsd: { specPath: "specs/p.gsd.md", milestoneId: "M001", mode } }),
    "utf8",
  );
  return tmp;
}

async function evalRows(tmp: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("runSteer", () => {
  test("passes the instruction through and logs an eval row with located manifest fields", async () => {
    const tmp = await makeProject();
    const { spawn, calls } = capture(JSON.stringify({ cost: { total: 0.42 } }));
    const r = await runSteer("focus on tests", { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "ok");
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "steer", "focus on tests"]);
    const rows = await evalRows(tmp);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, "steer");
    assert.equal(rows[0].steerText, "focus on tests");
    assert.equal(rows[0].milestoneId, "M001");
    assert.equal(rows[0].exitCode, 0);
    assert.equal(rows[0].cost, 0.42);
  });

  test("empty instruction: usage outcome, nothing spawned, no eval row", async () => {
    const tmp = await makeProject();
    const { spawn, calls } = capture();
    const r = await runSteer("   ", { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "usage");
    assert.equal(calls.length, 0);
    await assert.rejects(() => readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8"));
  });

  test("no manifest anywhere: still steers; row carries nulls", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-control-empty-"));
    const { spawn } = capture();
    const r = await runSteer("go", { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "ok");
    const rows = await evalRows(tmp);
    assert.equal(rows[0].milestoneId, null);
    assert.equal(rows[0].htmlPath, null);
  });
});

describe("runPause", () => {
  test("passthrough, summary only, NO eval row", async () => {
    const tmp = await makeProject();
    const { spawn, calls } = capture();
    const r = await runPause({ cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "ok");
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "pause"]);
    await assert.rejects(() => readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8"));
  });
});

describe("runStop", () => {
  test("passthrough + eval row without steerText", async () => {
    const tmp = await makeProject();
    const { spawn, calls } = capture();
    const r = await runStop({ cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "ok");
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "stop"]);
    const rows = await evalRows(tmp);
    assert.equal(rows[0].event, "stop");
    assert.equal("steerText" in rows[0], false);
  });
});

describe("runResume", () => {
  test("manifest mode auto -> gsd headless auto, custody reminder in message", async () => {
    const tmp = await makeProject("auto");
    const { spawn, calls } = capture();
    const r = await runResume(null, { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "ok");
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "auto"]);
    assert.ok(r.message.includes(CUSTODY_REMINDER));
  });

  test("manifest mode step -> gsd headless next", async () => {
    const tmp = await makeProject("step");
    const { spawn, calls } = capture();
    await runResume(null, { cwd: tmp, spawn, now: NOW });
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "next"]);
  });

  test("explicit path arg is accepted", async () => {
    const tmp = await makeProject("step");
    const { spawn, calls } = capture();
    const r = await runResume("specs/p.html", { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "ok");
    assert.deepEqual(calls[0], ["headless", "--output-format", "json", "next"]);
  });

  test("no manifest: not-located, nothing spawned", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-control-none-"));
    const { spawn, calls } = capture();
    const r = await runResume(null, { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "not-located");
    assert.equal(calls.length, 0);
  });
});
