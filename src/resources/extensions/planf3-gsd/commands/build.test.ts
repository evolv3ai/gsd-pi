import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBuild } from "./build.js";
import type { Spawner } from "../gsd/headless-runner.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("runBuild", () => {
  test("exports spec + manifest, creates milestone, persists milestoneId", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const calls: { args: string[] }[] = [];
    const spawn: Spawner = async (_cmd, args) => {
      calls.push({ args });
      if (args.includes("new-milestone")) {
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      if (args.includes("query")) {
        const snapshot = {
          state: { phase: "ready", activeMilestone: { id: "M042", title: "Minimal Plan" } },
          next: null,
          cost: { workers: [], total: 0 },
        };
        return { exitCode: 0, stdout: JSON.stringify(snapshot), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    };

    const result = await runBuild(htmlPath, { auto: false, binary: "gsd", cwd: tmp, spawn });
    assert.equal(result.milestoneId, "M042");
    assert.equal(result.status.phase, "ready");

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.gsd.milestoneId, "M042");
    assert.equal(manifest.gsd.mode, "step");

    const newMilestoneCall = calls.find((c) => c.args.includes("new-milestone"));
    assert.ok(newMilestoneCall);
    assert.deepEqual(newMilestoneCall!.args.slice(0, 4), ["headless", "--output-format", "json", "new-milestone"]);
    assert.ok(newMilestoneCall!.args.includes("--context"));
    assert.ok(!newMilestoneCall!.args.includes("--auto"));
  });

  test("passes --auto when auto=true", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-auto-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    let sawAuto = false;
    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone") && args.includes("--auto")) sawAuto = true;
      if (args.includes("query")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ state: { phase: "executing", activeMilestone: { id: "M9", title: "x" }, activeTask: { id: "T1", title: "t" } }, next: null, cost: { total: 0 } }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const result = await runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn });
    assert.equal(sawAuto, true);
    assert.equal(result.milestoneId, "M9");
  });

  test("writes the preferences overlay before new-milestone and appends an eval row", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-prefs-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    let prefsExistedAtMilestone = false;
    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) {
        try {
          await readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8");
          prefsExistedAtMilestone = true;
        } catch {
          prefsExistedAtMilestone = false;
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ state: { phase: "ready", activeMilestone: { id: "M042", title: "Minimal Plan" } }, next: null, cost: { total: 0.5 } }),
        stderr: "",
      };
    };

    const result = await runBuild(htmlPath, {
      auto: false,
      binary: "gsd",
      cwd: tmp,
      spawn,
      now: () => "2026-07-04T12:00:00Z",
    });

    assert.equal(prefsExistedAtMilestone, true, "overlay written before new-milestone");
    assert.equal(result.prefs.applied, true);
    assert.deepEqual(result.prefs.models, ["planning", "execution"]);
    assert.equal(result.prefs.warning, null);

    const prefs = await readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8");
    assert.match(prefs, /execution: openrouter\/x-ai\/grok-code-fast-1/);
    assert.match(prefs, /pnpm run verify:pr/);

    const evalLines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(evalLines.length, 1);
    const row = JSON.parse(evalLines[0]);
    assert.equal(row.milestoneId, "M042");
    assert.equal(row.loggedAt, "2026-07-04T12:00:00Z");
    assert.equal(row.cost, 0.5);
    assert.deepEqual(row.appliedModels, ["planning", "execution"]);
  });

  test("applyPrefs=false skips the overlay but still logs the eval row", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-noprefs-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ state: { phase: "ready", activeMilestone: { id: "M1", title: "x" } }, next: null, cost: { total: 0 } }),
        stderr: "",
      };
    };

    const result = await runBuild(htmlPath, { auto: false, binary: "gsd", cwd: tmp, spawn, applyPrefs: false });
    assert.equal(result.prefs.applied, false);
    await assert.rejects(() => readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8"));
    const evalText = await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8");
    assert.equal(evalText.trim().split("\n").length, 1);
  });

  test("a corrupt existing PREFERENCES.md yields a warning and does not block the build", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-badprefs-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    await mkdir(join(tmp, ".gsd"), { recursive: true });
    await writeFile(join(tmp, ".gsd", "PREFERENCES.md"), "---\nunclosed frontmatter\n", "utf8");

    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ state: { phase: "ready", activeMilestone: { id: "M2", title: "x" } }, next: null, cost: { total: 0 } }),
        stderr: "",
      };
    };

    const result = await runBuild(htmlPath, { auto: false, binary: "gsd", cwd: tmp, spawn });
    assert.equal(result.milestoneId, "M2");
    assert.equal(result.prefs.applied, false);
    assert.match(result.prefs.warning ?? "", /closing/);
    const untouched = await readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8");
    assert.equal(untouched, "---\nunclosed frontmatter\n");
  });

  // Failure eval rows — every throw path still logs a row (follow-up #1).
  test("export failure logs a failed:export eval row and rethrows", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-failexport-"));
    const spawn: Spawner = async () => ({ exitCode: 0, stdout: "{}", stderr: "" });

    await assert.rejects(
      () => runBuild(join(tmp, "missing.html"), { auto: true, binary: "gsd", cwd: tmp, spawn, now: () => "2026-07-05T00:00:00Z" }),
      /Plan file not found/,
    );

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.phase, "failed:export");
    assert.equal(row.milestoneId, null);
    assert.equal(row.specPath, "");
    assert.equal(row.mode, "auto");
    assert.equal(row.loggedAt, "2026-07-05T00:00:00Z");
  });

  test("new-milestone failure logs a failed:new-milestone eval row and rethrows", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-failnm-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 2, stdout: "", stderr: "boom" };
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    await assert.rejects(
      () => runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn }),
      /unexpected exit code 2/,
    );

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.phase, "failed:new-milestone");
    assert.equal(row.milestoneId, null);
    assert.ok(row.specPath.endsWith(".gsd.md"));
    // prefs were applied before the milestone attempt, so the row records them
    assert.deepEqual(row.appliedModels, ["planning", "execution"]);
  });

  test("query failure logs a failed:query eval row and rethrows", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-failq-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      return { exitCode: 2, stdout: "", stderr: "query broke" };
    };

    await assert.rejects(
      () => runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn }),
      /unexpected exit code 2/,
    );

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).phase, "failed:query");
  });

  // Settle loop + auto-chain honesty (replaces the retired A1 single-snapshot test).
  const NO_SLEEP = { attempts: 3, delayMs: 0 };

  function seqSpawner(snapshots: object[], calls: string[][]): Spawner {
    let queryCount = 0;
    return async (_cmd, args) => {
      calls.push(args);
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      if (args[args.length - 1] === "auto") return { exitCode: 0, stdout: "{}", stderr: "" };
      if (args.includes("query")) {
        const snap = snapshots[Math.min(queryCount, snapshots.length - 1)];
        queryCount += 1;
        return { exitCode: 0, stdout: JSON.stringify(snap), stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
  }

  const isAutoCall = (args: string[]) => args[args.length - 1] === "auto" && !args.includes("new-milestone");

  test("settle loop polls until the milestone appears; sessionId + sync fields land in the manifest", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-settle-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const calls: string[][] = [];
    const spawn = seqSpawner([
      { state: { phase: "idle" }, next: null, cost: { total: 0 } },                                   // baseline
      { state: { phase: "planning" }, next: null, cost: { total: 0 } },                               // settle #1: nothing yet
      { sessionId: "s-42", state: { phase: "executing", activeMilestone: { id: "M042", title: "Minimal Plan" }, activeTask: { id: "T1", title: "t" } }, next: null, cost: { total: 0 } }, // settle #2
    ], calls);

    const sleeps: number[] = [];
    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn, now: () => "2026-07-05T01:00:00Z",
      settle: { attempts: 3, delayMs: 7, sleep: async (ms) => { sleeps.push(ms); } },
    });

    assert.equal(result.milestoneId, "M042");
    assert.equal(result.autoChain, "chained");
    assert.deepEqual(sleeps, [7]);
    assert.equal(calls.filter(isAutoCall).length, 0, "no relaunch when execution is visibly running");

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.gsd.milestoneId, "M042");
    assert.equal(manifest.gsd.headlessSessionId, "s-42");
    assert.equal(manifest.validation.lastSyncedAt, "2026-07-05T01:00:00Z");
    assert.equal(manifest.validation.lastStatus, "running");
  });

  test("completed auto build: milestoneId from a CHANGED lastCompletedMilestone, no relaunch, lastStatus passed", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-chained-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const calls: string[][] = [];
    const spawn = seqSpawner([
      { state: { phase: "idle", lastCompletedMilestone: null }, next: null, cost: { total: 0 } },      // baseline
      { state: { phase: "done", activeMilestone: null, lastCompletedMilestone: { id: "M77", title: "Auto Plan" } }, next: null, cost: { total: 1.5 } },
    ], calls);

    const result = await runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, settle: { ...NO_SLEEP, sleep: async () => {} } });

    assert.equal(result.milestoneId, "M77");
    assert.equal(result.autoChain, "chained");
    assert.equal(calls.filter(isAutoCall).length, 0);

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.gsd.milestoneId, "M77");
    assert.equal(manifest.validation.lastStatus, "passed");
    // call shape: baseline query precedes new-milestone, which precedes the settle query
    const kinds = calls.map((a) => a.includes("new-milestone") ? "nm" : a.includes("query") ? "q" : "other");
    assert.deepEqual(kinds.slice(0, 3), ["q", "nm", "q"]);
  });

  test("suppressed auto chain: one relaunch, honest auto-relaunched eval phase", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-relaunch-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    // The milestone stays merely-queued through ALL settle attempts (the loop
    // must not latch onto it early — re-keying defense), then executes only
    // after the explicit relaunch.
    const ready = { state: { phase: "ready", activeMilestone: { id: "M9", title: "x" }, activeTask: null, lastCompletedMilestone: null }, next: null, cost: { total: 0 } };
    const calls: string[][] = [];
    const spawn = seqSpawner([
      { state: { phase: "idle", lastCompletedMilestone: null }, next: null, cost: { total: 0 } },      // baseline
      ready, ready, ready,                                                                              // settle attempts 1-3: planned, never executing
      { state: { phase: "done", activeMilestone: null, lastCompletedMilestone: { id: "M9", title: "x" } }, next: null, cost: { total: 2 } },                    // after relaunch
    ], calls);

    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn, now: () => "2026-07-05T02:00:00Z",
      settle: { ...NO_SLEEP, sleep: async () => {} },
    });

    assert.equal(calls.filter(isAutoCall).length, 1, "exactly one auto relaunch");
    assert.equal(result.autoChain, "relaunched");
    assert.equal(result.milestoneId, "M9");

    const evalLines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(evalLines[evalLines.length - 1]).phase, "auto-relaunched");
  });

  test("blockers present: never relaunch past a pause, lastStatus blocked", async () => {
    // Pauses are sacred: both pauses in the live run (safety evidence-xref,
    // needs-attention verdict) required human judgment. Blind relaunch past
    // the first one is what adopted stranded work into an unattributed commit.
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-blocked-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const paused = { state: { phase: "paused", activeMilestone: { id: "M9", title: "x" }, activeTask: null, lastCompletedMilestone: null, blockers: [{ reason: "safety pause" }] }, next: null, cost: { total: 0 } };
    const calls: string[][] = [];
    const spawn = seqSpawner([
      { state: { phase: "idle", lastCompletedMilestone: null }, next: null, cost: { total: 0 } },
      paused, paused,
    ], calls);

    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn,
      settle: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });

    assert.equal(calls.filter(isAutoCall).length, 0, "no relaunch past a blocker/pause");
    assert.equal(result.autoChain, "not-started");
    assert.equal(result.milestoneId, "M9");

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.validation.lastStatus, "blocked");
  });

  test("new-milestone exiting blocked (10) suppresses the relaunch", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-nm10-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const calls: string[][] = [];
    const spawn: Spawner = async (_cmd, args) => {
      calls.push(args);
      if (args.includes("new-milestone")) return { exitCode: 10, stdout: "{}", stderr: "blocked" };
      return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "ready", activeMilestone: { id: "M9", title: "x" }, activeTask: null, lastCompletedMilestone: null }, next: null, cost: { total: 0 } }), stderr: "" };
    };

    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn,
      settle: { attempts: 1, delayMs: 0, sleep: async () => {} },
    });

    assert.equal(calls.filter(isAutoCall).length, 0, "exit 10 means blocked — no relaunch");
    assert.equal(result.autoChain, "not-started");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.validation.lastStatus, "planned");
  });

  test("relaunch that still does not execute reports auto-not-started", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-notstart-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const calls: string[][] = [];
    const stuck = { state: { phase: "ready", activeMilestone: { id: "M9", title: "x" }, activeTask: null, lastCompletedMilestone: null }, next: null, cost: { total: 0 } };
    const spawn = seqSpawner([
      { state: { phase: "idle", lastCompletedMilestone: null }, next: null, cost: { total: 0 } },
      stuck, stuck, stuck, stuck,
    ], calls);

    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn,
      settle: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });

    assert.equal(calls.filter(isAutoCall).length, 1);
    assert.equal(result.autoChain, "not-started");
    assert.equal(result.milestoneId, "M9");

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.validation.lastStatus, "planned");
    const evalLines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(evalLines[evalLines.length - 1]).phase, "auto-not-started");
  });
});
