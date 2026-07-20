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

    const result = await runBuild(htmlPath, { auto: false, allowUnsafeStep: true, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md") });
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

    const result = await runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md") });
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
      allowUnsafeStep: true,
      binary: "gsd",
      cwd: tmp,
      spawn,
      now: () => "2026-07-04T12:00:00Z",
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
    });

    assert.equal(prefsExistedAtMilestone, true, "overlay written before new-milestone");
    assert.equal(result.prefs.applied, true);
    assert.deepEqual(result.prefs.buckets, ["planning", "execution"]);
    assert.deepEqual(result.prefs.models, {
      planning: "openrouter/anthropic/claude-opus-4.7",
      execution: "openrouter/x-ai/grok-code-fast-1",
    });
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
    assert.deepEqual(row.appliedBuckets, ["planning", "execution"]);
    assert.deepEqual(row.appliedModels, {
      planning: "openrouter/anthropic/claude-opus-4.7",
      execution: "openrouter/x-ai/grok-code-fast-1",
    });
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

    const result = await runBuild(htmlPath, { auto: false, allowUnsafeStep: true, binary: "gsd", cwd: tmp, spawn, applyPrefs: false, force: true, globalPrefsPath: join(tmp, "no-global.md") });
    assert.equal(result.prefs.applied, false);
    await assert.rejects(() => readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8"));
    const evalText = await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8");
    assert.equal(evalText.trim().split("\n").length, 1);
  });

  // writeRecordFor() is declared later in this describe block (function
  // declarations hoist), signing off the fixture plan's projection so the
  // gate passes without --force.
  test("a corrupt existing PREFERENCES.md yields a warning and does not block the build", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-badprefs-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    const globalPrefs = join(tmp, "no-global.md");
    await writeRecordFor(tmp, htmlPath, globalPrefs);
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

    // No force: true here — proving finding #1 is fixed (the preflight gate
    // must not swallow this corruption into a build-blocking refusal).
    const result = await runBuild(htmlPath, { auto: false, allowUnsafeStep: true, binary: "gsd", cwd: tmp, spawn, globalPrefsPath: globalPrefs });
    assert.equal(result.milestoneId, "M2");
    assert.equal(result.prefs.applied, false);
    assert.match(result.prefs.warning ?? "", /closing/);
    const untouched = await readFile(join(tmp, ".gsd", "PREFERENCES.md"), "utf8");
    assert.equal(untouched, "---\nunclosed frontmatter\n");
  });

  // Finding #1 (Task 10 review): checkPresetsGate's disk-recomputation must
  // degrade a corrupt PREFERENCES.md the same way readOrNull degrades an
  // unreadable one — never a presets refusal. applyPreferencesOverlay is
  // independently where the user-facing warning comes from (unchanged).
  test("corrupt PREFERENCES.md never surfaces as a presets refusal, even without --force (finding #1 regression)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-badprefs-gate-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    const globalPrefs = join(tmp, "no-global.md");
    await writeRecordFor(tmp, htmlPath, globalPrefs);
    await mkdir(join(tmp, ".gsd"), { recursive: true });
    await writeFile(join(tmp, ".gsd", "PREFERENCES.md"), "---\nunclosed frontmatter\n", "utf8");

    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "ready", activeMilestone: { id: "M3", title: "x" } }, next: null, cost: { total: 0 } }), stderr: "" };
    };

    const result = await runBuild(htmlPath, {
      auto: false, allowUnsafeStep: true, binary: "gsd", cwd: tmp, spawn,
      globalPrefsPath: globalPrefs, now: () => "2026-07-06T09:00:00Z",
    });

    assert.equal(result.presets, "ok", "the gate itself must not treat corrupt project prefs as unverifiable");
    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    for (const line of lines) {
      assert.doesNotMatch(JSON.parse(line).phase, /^preflight-refused/, "corrupt PREFERENCES.md must never log a presets refusal");
    }
    assert.match(result.prefs.warning ?? "", /closing/, "the SAME corruption still warns via applyPreferencesOverlay downstream");
  });

  // Failure eval rows — every throw path still logs a row (follow-up #1).
  test("export failure logs a failed:export eval row and rethrows", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-failexport-"));
    const spawn: Spawner = async () => ({ exitCode: 0, stdout: "{}", stderr: "" });

    // No force: true — a missing plan html throws before the gate can even
    // read the (nonexistent) PRESETS record, so this needs no bypass.
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

  // Finding #2 (Task 10 review): a missing/moved plan html must be attributed
  // to the SAME failed:export marker/message runExport's own ENOENT handling
  // uses — never conflated with a presets refusal, and never a wrong phase in
  // the eval-log taxonomy.
  test("missing plan html without --force is attributed to failed:export, not a presets refusal (finding #2 regression)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-missinghtml-gate-"));
    const spawn: Spawner = async () => ({ exitCode: 0, stdout: "{}", stderr: "" });

    await assert.rejects(
      () => runBuild(join(tmp, "moved.html"), { auto: true, binary: "gsd", cwd: tmp, spawn, now: () => "2026-07-06T09:05:00Z" }),
      /Plan file not found/,
    );

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.phase, "failed:export", "must be attributed to the export/html-read failure, not the presets gate");
    assert.notEqual(row.phase, "preflight-refused:absent");
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
      () => runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md") }),
      /unexpected exit code 2/,
    );

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.phase, "failed:new-milestone");
    assert.equal(row.milestoneId, null);
    assert.ok(row.specPath.endsWith(".gsd.md"));
    // prefs were applied before the milestone attempt, so the row records them
    assert.deepEqual(row.appliedBuckets, ["planning", "execution"]);
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
      () => runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md") }),
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
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
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

    const result = await runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md"), settle: { ...NO_SLEEP, sleep: async () => {} } });

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
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
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
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
      settle: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });

    assert.equal(calls.filter(isAutoCall).length, 0, "no relaunch past a blocker/pause");
    // F3: a live pause (blockers present) is execution having happened, not
    // "nothing started" — deriveLastStatus still dominates to "blocked" below
    // regardless of this discrimination.
    assert.equal(result.autoChain, "stopped-at-pause");
    assert.equal(result.milestoneId, "M9");

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.validation.lastStatus, "blocked");
  });

  test("stopped-at-pause: execution happened (progress.tasks.done > 0) but no completion → auto-stopped-at-pause, cost from observed max", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-stopped-at-pause-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    // baseline: nothing yet. settle #1..#3: tasks progressed but no active
    // task and no lastCompleted change (S01 completed inside a milestone, but
    // the milestone itself hasn't). Final query: cost.total is 0 (upstream
    // "forgetting" cost at this state — the exact T4 signature).
    const settled = { state: { phase: "waiting", activeMilestone: { id: "M1", title: "t" }, activeSlice: null, activeTask: null, lastCompletedMilestone: null, progress: { milestones: { done: 0, total: 1 }, slices: { done: 1, total: 3 }, tasks: { done: 3, total: 9 } } }, next: null, cost: { total: 4.78 } };
    const forgotten = { ...settled, cost: { total: 0 } };
    const calls: string[][] = [];
    const spawn = seqSpawner([
      { state: { phase: "idle", lastCompletedMilestone: null }, next: null, cost: { total: 0 } },  // baseline
      settled, settled, settled,                                                                    // settle attempts
      forgotten,                                                                                    // after the else branch — no relaunch fires
    ], calls);

    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn, now: () => "2026-07-07T07:00:00Z",
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
      settle: { ...NO_SLEEP, sleep: async () => {} },
    });

    assert.equal(result.autoChain, "stopped-at-pause");
    assert.equal(calls.filter(isAutoCall).length, 0, "no relaunch: not the zeroExecutionDispatches shape");

    const rows = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const last = rows[rows.length - 1];
    assert.equal(last.phase, "auto-stopped-at-pause");
    assert.equal(last.cost, 4.78, "attribution: max observed cost across snapshots, not the final query's zero");
  });

  test("cost attribution: settle-loop max wins over both baseline and post-loop query", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-cost-max-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const calls: string[][] = [];
    const spawn = seqSpawner([
      { state: { phase: "idle", lastCompletedMilestone: null }, next: null, cost: { total: 0.10 } },   // baseline
      { state: { phase: "planning" }, next: null, cost: { total: 1.25 } },                              // settle #1
      { state: { phase: "executing", activeMilestone: { id: "M1", title: "x" }, activeTask: { id: "T1", title: "t" } }, next: null, cost: { total: 0.50 } }, // settle #2 (breaks the loop; final row will use MAX across all three)
    ], calls);

    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn, now: () => "2026-07-07T07:05:00Z",
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
      settle: { attempts: 3, delayMs: 0, sleep: async () => {} },
    });
    assert.equal(result.autoChain, "chained");

    const rows = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows[rows.length - 1].cost, 1.25, "max across baseline (0.10), settle#1 (1.25), settle#2 (0.50)");
  });

  test("M4: failed:new-milestone row carries the baseline cost", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-m4-nm-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 7, stdout: "", stderr: "nm broke" };
      if (args.includes("query")) {
        return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "idle" }, next: null, cost: { total: 0.8 } }), stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    await assert.rejects(
      () => runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md") }),
      /unexpected exit code 7/,
    );

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.phase, "failed:new-milestone");
    assert.equal(row.cost, 0.8, "M4: baseline spend was observed before the failure — the row must carry it");
  });

  test("M4: failed:query row carries the baseline cost", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-m4-query-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    let queryCount = 0;
    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      if (args.includes("query")) {
        queryCount += 1;
        if (queryCount === 1) {
          return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "idle" }, next: null, cost: { total: 1.2 } }), stderr: "" };
        }
        return { exitCode: 2, stdout: "", stderr: "query broke" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    await assert.rejects(
      () => runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md") }),
      /unexpected exit code 2/,
    );

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.phase, "failed:query");
    assert.equal(row.cost, 1.2);
  });

  test("M4: failed:auto-relaunch row carries the max observed cost, not zero", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-m4-relaunch-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    // Queued-but-never-executing milestone (no activeTask, no completion, no
    // blockers) → the one-shot relaunch fires; the relaunch itself then fails.
    const stuck = { state: { phase: "ready", activeMilestone: { id: "M9", title: "x" }, activeTask: null, lastCompletedMilestone: null }, next: null, cost: { total: 2.4 } };
    let queryCount = 0;
    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      if (args[args.length - 1] === "auto") return { exitCode: 7, stdout: "", stderr: "relaunch broke" };
      if (args.includes("query")) {
        queryCount += 1;
        if (queryCount === 1) {
          return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "idle", lastCompletedMilestone: null }, next: null, cost: { total: 0.1 } }), stderr: "" };
        }
        return { exitCode: 0, stdout: JSON.stringify(stuck), stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    await assert.rejects(
      () => runBuild(htmlPath, {
        auto: true, binary: "gsd", cwd: tmp, spawn,
        force: true, globalPrefsPath: join(tmp, "no-global.md"),
        settle: { attempts: 2, delayMs: 0, sleep: async () => {} },
      }),
      /unexpected exit code 7/,
    );

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.phase, "failed:auto-relaunch");
    assert.equal(row.cost, 2.4, "M4: settle-loop max (2.4) beats baseline (0.1); abort rows must not log 0");
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
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
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
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
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

  test("relaunch that stops at a pause reports auto-stopped-at-pause, not not-started (twin-branch parity)", async () => {
    // F3 fixed pause attribution on the no-relaunch path; the post-relaunch
    // twin must discriminate the same way. A relaunched run that pauses on a
    // blocker is execution having happened — not "nothing started".
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-relaunch-pause-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const calls: string[][] = [];
    const stuck = { state: { phase: "ready", activeMilestone: { id: "M9", title: "x" }, activeTask: null, lastCompletedMilestone: null }, next: null, cost: { total: 0 } };
    const pausedAfterRelaunch = { state: { phase: "paused", activeMilestone: { id: "M9", title: "x" }, activeTask: null, lastCompletedMilestone: null, blockers: [{ reason: "safety pause" }], progress: { milestones: { done: 0, total: 1 }, slices: { done: 0, total: 2 }, tasks: { done: 2, total: 6 } } }, next: null, cost: { total: 3.1 } };
    const spawn = seqSpawner([
      { state: { phase: "idle", lastCompletedMilestone: null }, next: null, cost: { total: 0 } },  // baseline
      stuck, stuck,                                                                                 // settle attempts: planned, never executing
      pausedAfterRelaunch,                                                                          // post-relaunch query: paused on a blocker
    ], calls);

    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn, now: () => "2026-07-07T08:00:00Z",
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
      settle: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });

    assert.equal(calls.filter(isAutoCall).length, 1, "exactly one auto relaunch");
    assert.equal(result.autoChain, "stopped-at-pause");
    assert.equal(result.milestoneId, "M9");

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.validation.lastStatus, "blocked", "blockers dominate lastStatus regardless of autoChain");
    const evalLines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(evalLines[evalLines.length - 1]).phase, "auto-stopped-at-pause");
  });

  // Step-mode guard: headless new-milestone deadlocks on the depth gate, so
  // plain step mode must refuse fast (see STEP_MODE_HEADLESS_ERROR).
  test("step mode without --step-unsafe fails fast before export", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-stepguard-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    let spawned = false;
    const spawn: Spawner = async () => { spawned = true; return { exitCode: 0, stdout: "{}", stderr: "" }; };

    await assert.rejects(() => runBuild(htmlPath, { auto: false, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md") }), /depth-verification/);
    assert.equal(spawned, false, "no gsd subprocess ran");
    await assert.rejects(() => readFile(join(tmp, "minimal.gsd.md"), "utf8"), "no spec exported");
  });

  test("allowUnsafeStep restores step-mode behavior", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-stepunsafe-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "ready", activeMilestone: { id: "M042", title: "Minimal Plan" } }, next: null, cost: { total: 0 } }), stderr: "" };
    };

    const result = await runBuild(htmlPath, { auto: false, allowUnsafeStep: true, binary: "gsd", cwd: tmp, spawn, force: true, globalPrefsPath: join(tmp, "no-global.md") });
    assert.equal(result.milestoneId, "M042");
    assert.equal(result.autoChain, "not-applicable");
  });

  // Enforced-lite gate (spec §7). writeRecord() signs off the fixture plan's
  // projection so the gate passes; tests that want refusal skip it.
  async function writeRecordFor(tmp: string, htmlPath: string, globalPrefsPath: string): Promise<string> {
    const { runPreflight, signOffPreflight } = await import("../preflight/run.js");
    const { issueApprovalToken } = await import("../preflight/approval-token.js");
    const deps = {
      projectRoot: tmp, htmlPath, offline: true, ping: false,
      catalog: { ids: () => [] },
      orchestrator: { host: "test", model: "t/m", authMode: "none", skills: [] },
      env: {}, now: () => "2026-07-06T08:00:00Z", globalPrefsPath,
      spawn: (async () => ({ exitCode: 1, stdout: "", stderr: "" })) as Spawner,
    };
    const probe = await runPreflight(deps);
    const token = await issueApprovalToken(tmp, probe.approvalHash, { now: () => new Date("2026-07-06T08:00:00Z") });
    const { approvalHash } = await signOffPreflight(deps, null, token);
    return approvalHash;
  }

  test("no PRESETS record: refuses before export, logs preflight-refused:absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gate-absent-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    let spawned = false;
    const spawn: Spawner = async () => { spawned = true; return { exitCode: 0, stdout: "{}", stderr: "" }; };

    await assert.rejects(
      () => runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, globalPrefsPath: join(tmp, "no-global.md"), now: () => "2026-07-06T08:10:00Z" }),
      /preflight gate: .*run \/planf3-gsd-preflight/s,
    );
    assert.equal(spawned, false, "refusal happens before any gsd subprocess");
    await assert.rejects(() => readFile(join(tmp, "minimal.gsd.md"), "utf8"), "no spec exported");
    const row = JSON.parse((await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim());
    assert.equal(row.phase, "preflight-refused:absent");
    assert.equal(row.presets, "absent");
  });

  test("drifted prefs: refuses with the field diff, logs preflight-refused:drift", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gate-drift-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    const globalPrefs = join(tmp, "no-global.md");
    await writeRecordFor(tmp, htmlPath, globalPrefs);
    // Out-of-band edit AFTER sign-off. It must touch a bucket the fixture's
    // #model-policy does NOT govern (the fixture sets planning + execution;
    // the projection re-applies those and would mask an edit to them) —
    // `validation` is plan-ungoverned, so it drifts.
    await mkdir(join(tmp, ".gsd"), { recursive: true });
    await writeFile(join(tmp, ".gsd", "PREFERENCES.md"), "---\nversion: 1\nmodels:\n  validation: claude-code/claude-haiku-4-5\n---\n", "utf8");

    await assert.rejects(
      () => runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }), globalPrefsPath: globalPrefs }),
      /configuration drifted since sign-off[\s\S]*buckets\.validation/,
    );
    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.phase, "preflight-refused:drift");
    assert.equal(row.presets, "drift");
  });

  test("F1b: unsigned-projection refusal uses preflight-refused:unsigned-projection marker", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-unsigned-proj-"));
    const htmlPath = join(tmp, "specs", "minimal.html");
    const otherPath = join(tmp, "specs", "other.html");
    await mkdir(join(tmp, "specs"), { recursive: true });
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), otherPath);
    // Sign the record for `htmlPath` (absolute path lands in projectedFrom).
    const { runPreflight, signOffPreflight } = await import("../preflight/run.js");
    const { issueApprovalToken } = await import("../preflight/approval-token.js");
    const signDeps = {
      projectRoot: tmp, htmlPath, offline: true, ping: false,
      catalog: { ids: () => [] }, orchestrator: null,
    };
    const signProbe = await runPreflight(signDeps);
    const signToken = await issueApprovalToken(tmp, signProbe.approvalHash);
    await signOffPreflight(signDeps, null, signToken);

    const spawn: Spawner = async () => ({ exitCode: 0, stdout: "{}", stderr: "" });
    await assert.rejects(
      () => runBuild(otherPath, { auto: true, binary: "gsd", cwd: tmp, spawn, now: () => "2026-07-07T05:00:00Z" }),
      /never signed/,
    );

    const rows = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows[rows.length - 1].phase, "preflight-refused:unsigned-projection");
    assert.equal(rows[rows.length - 1].presets, "absent");
    assert.ok(rows[rows.length - 1].presetsHash, "the projection was hashed even though the record didn't cover it");
  });

  test("--force proceeds past absence and records presets forced", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gate-forced-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "executing", activeMilestone: { id: "M1", title: "x" }, activeTask: { id: "T1", title: "t" } }, next: null, cost: { total: 0 } }), stderr: "" };
    };
    const result = await runBuild(htmlPath, { auto: true, force: true, binary: "gsd", cwd: tmp, spawn, globalPrefsPath: join(tmp, "no-global.md") });
    assert.equal(result.presets, "forced");
    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    const row = JSON.parse(lines[lines.length - 1]);
    assert.equal(row.presets, "forced");
    assert.equal(typeof row.presetsHash, "string");
  });

  test("corrupt PRESETS + --force: manifest presets stamp is type-honest null", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gate-corrupt-forced-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    await mkdir(join(tmp, "specs"), { recursive: true });
    await writeFile(join(tmp, "specs", "PRESETS.md"), "not a presets file\n", "utf8");
    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "executing", activeMilestone: { id: "M1", title: "x" }, activeTask: { id: "T1", title: "t" } }, next: null, cost: { total: 0 } }), stderr: "" };
    };
    const result = await runBuild(htmlPath, { auto: true, force: true, binary: "gsd", cwd: tmp, spawn, globalPrefsPath: join(tmp, "no-global.md") });
    assert.equal(result.presets, "forced");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.deepEqual(manifest.presets, { path: join("specs", "PRESETS.md"), approvalHash: null });
    const rows = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows[rows.length - 1].presetsHash, null);
  });

  test("signed-off record: gate passes, manifest re-stamped with the verified hash", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gate-ok-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    const globalPrefs = join(tmp, "no-global.md");
    const approvalHash = await writeRecordFor(tmp, htmlPath, globalPrefs);
    const spawn: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "{}", stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ state: { phase: "executing", activeMilestone: { id: "M1", title: "x" }, activeTask: { id: "T1", title: "t" } }, next: null, cost: { total: 0 } }), stderr: "" };
    };
    const result = await runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn, globalPrefsPath: globalPrefs });
    assert.equal(result.presets, "ok");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.deepEqual(manifest.presets, { path: join("specs", "PRESETS.md"), approvalHash });
    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(lines[lines.length - 1]).presets, "ok");
  });
});

describe("runBuild — headless idle guard (F4 / upstream #1294)", () => {
  test("hangs on newMilestone: idle guard aborts, logs failed:headless-idle, throws #1294-tagged error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-idle-nm-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    // baseline query fine; new-milestone hangs forever unless the signal aborts.
    const spawn: Spawner = (_cmd, args, opts) => {
      if (args.includes("new-milestone")) {
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
          // never resolves otherwise
        });
      }
      // baseline query
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ state: { phase: "idle" }, next: null, cost: { total: 0 } }), stderr: "" });
    };

    await assert.rejects(
      () => runBuild(htmlPath, {
        auto: true, binary: "gsd", cwd: tmp, spawn,
        force: true, globalPrefsPath: join(tmp, "no-global.md"),
        headlessIdleMs: 50,       // 50ms so the test is fast
        now: () => "2026-07-07T06:00:00Z",
      }),
      /gsd idled headless.*#1294/,
    );

    const rows = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows[rows.length - 1].phase, "failed:headless-idle");
  });

  test("periodic output resets the idle timer — a long-running-but-progressing child is NOT aborted", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-idle-progress-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    // new-milestone emits three progress chunks 30ms apart, then finishes.
    // Idle window is 100ms → this must NOT trigger.
    const spawn: Spawner = (_cmd, args, opts) => {
      if (args.includes("new-milestone")) {
        return new Promise((resolve) => {
          let i = 0;
          const emit = () => {
            if (i++ < 3) { opts.onStdout?.(`progress ${i}\n`); setTimeout(emit, 30); }
            else resolve({ exitCode: 0, stdout: "{}", stderr: "" });
          };
          setTimeout(emit, 30);
        });
      }
      if (args.includes("query")) {
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ state: { phase: "executing", activeMilestone: { id: "M1", title: "t" }, activeTask: { id: "T1", title: "t" } }, next: null, cost: { total: 0 } }), stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "" });
    };

    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn,
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
      headlessIdleMs: 100, now: () => "2026-07-07T06:05:00Z",
    });
    assert.equal(result.milestoneId, "M1");
  });

  test("fast-path: 'menu could not be shown' substring aborts immediately (#1294 deterministic signature)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-idle-menu-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const spawn: Spawner = (_cmd, args, opts) => {
      if (args.includes("new-milestone")) {
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          setTimeout(() => opts.onStdout?.("GSD — M003: M003 menu could not be shown in this session.\n"), 10);
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ state: { phase: "idle" }, next: null, cost: { total: 0 } }), stderr: "" });
    };

    const started = Date.now();
    await assert.rejects(
      () => runBuild(htmlPath, {
        auto: true, binary: "gsd", cwd: tmp, spawn,
        force: true, globalPrefsPath: join(tmp, "no-global.md"),
        headlessIdleMs: 10_000,   // long window: only the fast-path can end this quickly
        now: () => "2026-07-07T06:10:00Z",
      }),
      /#1294/,
    );
    assert.ok(Date.now() - started < 3_000, "fast-path aborted well before the 10s idle window");
  });
});

describe("runBuild — activity-probe idle guard (F6.0-5: silent JSON-mode children)", () => {
  // JSON-mode children emit NO incremental stdout (e2e grok-m4 F-G7) — the
  // probe is the only liveness signal in every test below.
  const silentChild = (durationMs: number): Spawner => (_cmd, args, opts) => {
    if (args.includes("new-milestone")) {
      return new Promise((resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
        setTimeout(() => resolve({ exitCode: 0, stdout: "{}", stderr: "" }), durationMs);
      });
    }
    return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ state: { phase: "executing", activeMilestone: { id: "M1", title: "t" }, activeTask: { id: "T1", title: "t" } }, next: null, cost: { total: 0 } }), stderr: "" });
  };

  async function scaffoldPlan(prefix: string): Promise<{ tmp: string; htmlPath: string }> {
    const tmp = await mkdtemp(join(tmpdir(), prefix));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);
    return { tmp, htmlPath };
  }

  test("silent child + advancing activity stamps → NOT aborted, build completes", async () => {
    const { tmp, htmlPath } = await scaffoldPlan("planf3-probe-alive-");
    let tick = 0;
    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn: silentChild(200),
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
      headlessIdleMs: 80, probeIntervalMs: 20,
      activityStamp: async () => ++tick, // strictly increasing → always alive
      now: () => "2026-07-20T10:00:00Z",
    });
    assert.equal(result.milestoneId, "M1");
  });

  test("silent child + frozen stamp → aborted at idleMs, failed:headless-idle row, message names .gsd activity", async () => {
    const { tmp, htmlPath } = await scaffoldPlan("planf3-probe-frozen-");
    await assert.rejects(
      () => runBuild(htmlPath, {
        auto: true, binary: "gsd", cwd: tmp, spawn: silentChild(60_000),
        force: true, globalPrefsPath: join(tmp, "no-global.md"),
        headlessIdleMs: 80, probeIntervalMs: 20,
        activityStamp: async () => 12_345, // never advances
        now: () => "2026-07-20T10:05:00Z",
      }),
      /no stdout and no \.gsd activity.*#1294/,
    );
    const rows = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows[rows.length - 1].phase, "failed:headless-idle");
  });

  test("silent child + null stamps (no .gsd observable) → aborted — can't-see is NOT alive", async () => {
    const { tmp, htmlPath } = await scaffoldPlan("planf3-probe-null-");
    await assert.rejects(
      () => runBuild(htmlPath, {
        auto: true, binary: "gsd", cwd: tmp, spawn: silentChild(60_000),
        force: true, globalPrefsPath: join(tmp, "no-global.md"),
        headlessIdleMs: 80, probeIntervalMs: 20,
        activityStamp: async () => null,
        now: () => "2026-07-20T10:10:00Z",
      }),
      /no stdout and no \.gsd activity/,
    );
  });

  test("probe that throws → treated as no signal (aborts at idleMs; never crashes the build differently)", async () => {
    const { tmp, htmlPath } = await scaffoldPlan("planf3-probe-throws-");
    await assert.rejects(
      () => runBuild(htmlPath, {
        auto: true, binary: "gsd", cwd: tmp, spawn: silentChild(60_000),
        force: true, globalPrefsPath: join(tmp, "no-global.md"),
        headlessIdleMs: 80, probeIntervalMs: 20,
        activityStamp: async () => { throw new Error("probe exploded"); },
        now: () => "2026-07-20T10:15:00Z",
      }),
      /no stdout and no \.gsd activity/, // the idle abort, NOT "probe exploded"
    );
  });

  test("headlessIdleMs 0 disables timer AND probe — stamp fn is never called", async () => {
    const { tmp, htmlPath } = await scaffoldPlan("planf3-probe-off-");
    let called = 0;
    const result = await runBuild(htmlPath, {
      auto: true, binary: "gsd", cwd: tmp, spawn: silentChild(150),
      force: true, globalPrefsPath: join(tmp, "no-global.md"),
      headlessIdleMs: 0, probeIntervalMs: 10,
      activityStamp: async () => { called++; return 1; },
      now: () => "2026-07-20T10:20:00Z",
    });
    assert.equal(result.milestoneId, "M1");
    assert.equal(called, 0, "idleMs 0 must not start the probe");
  });
});
