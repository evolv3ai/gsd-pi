import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile } from "node:fs/promises";
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
});
