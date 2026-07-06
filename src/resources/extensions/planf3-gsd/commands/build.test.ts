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
          stdout: JSON.stringify({ state: { phase: "executing", activeMilestone: { id: "M9", title: "x" } }, next: null, cost: { total: 0 } }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const result = await runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn });
    assert.equal(sawAuto, true);
    assert.equal(result.milestoneId, "M9");
  });

  // C2: auto-mode manifest persistence + call order lock
  test("auto mode: milestoneId from lastCompletedMilestone persists to manifest; new-milestone precedes query", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-auto2-"));
    const htmlPath = join(tmp, "minimal.html");
    await copyFile(join(here, "..", "fixtures", "minimal-plan.html"), htmlPath);

    const callOrder: string[] = [];
    const spawn: Spawner = async (_cmd, args) => {
      // Record subcommand name for ordering assertions
      if (args.includes("new-milestone")) callOrder.push("new-milestone");
      if (args.includes("query")) callOrder.push("query");

      if (args.includes("new-milestone")) {
        // auto mode: new-milestone blocks and completes; activeMilestone will be null
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
      if (args.includes("query")) {
        // After auto run completes, activeMilestone is null; lastCompletedMilestone holds the id
        const snapshot = {
          state: {
            phase: "done",
            activeMilestone: null,
            lastCompletedMilestone: { id: "M77", title: "Auto Plan" },
          },
          next: null,
          cost: { total: 0 },
        };
        return { exitCode: 0, stdout: JSON.stringify(snapshot), stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const result = await runBuild(htmlPath, { auto: true, binary: "gsd", cwd: tmp, spawn });

    // milestoneId from lastCompletedMilestone
    assert.equal(result.milestoneId, "M77");

    // manifest persisted
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.gsd.milestoneId, "M77");
    assert.equal(manifest.gsd.mode, "auto");

    // call order: new-milestone must precede query
    const nmIdx = callOrder.indexOf("new-milestone");
    const qIdx = callOrder.indexOf("query");
    assert.ok(nmIdx !== -1, "new-milestone was called");
    assert.ok(qIdx !== -1, "query was called");
    assert.ok(nmIdx < qIdx, "new-milestone call precedes query call");
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
});
