import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBuild } from "./build.js";
import type { Spawner } from "../gsd/headless-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, "..", "fixtures", "minimal-plan.html"), "utf8");
const NOW = () => "2026-07-19T14:00:00Z";

async function makeProject(): Promise<{ tmp: string; htmlPath: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-buildsync-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  const htmlPath = join(tmp, "specs", "minimal.html");
  await writeFile(htmlPath, FIXTURE, "utf8");
  return { tmp, htmlPath };
}

/** Sequenced spawner: new-milestone succeeds; the baseline query (taken
 *  before new-milestone) reports no completion yet, and every query after
 *  new-milestone reports the completed-milestone snapshot. Baseline must
 *  differ from the post-build snapshot (as every other runBuild test does)
 *  so lastCompletedMilestone drift is visible — otherwise runBuild's
 *  auto-chain relaunch (unrelated to this task) fires an extra `auto` call
 *  the settle loop never needed, which is not what this fixture is
 *  exercising. Settle exits immediately, and the build-return sync sees the
 *  same completion. */
function completedFlowSpawner(): Spawner {
  const empty = JSON.stringify({ state: { phase: "idle", lastCompletedMilestone: null }, cost: { total: 0 } });
  const completed = JSON.stringify({
    state: { phase: "idle", lastCompletedMilestone: { id: "M042", title: "Minimal Plan" } },
    cost: { total: 1 },
  });
  let milestoneCreated = false;
  return async (_cmd, args) => {
    if (args.includes("new-milestone")) {
      milestoneCreated = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    assert.equal(args[args.length - 1], "query");
    return { exitCode: 0, stdout: milestoneCreated ? completed : empty, stderr: "" };
  };
}

describe("runBuild — build-return sync (M4)", () => {
  test("a stamped milestone triggers an in-process sync that moves markers", async () => {
    const { tmp, htmlPath } = await makeProject();
    const result = await runBuild(htmlPath, {
      auto: true, force: true, applyPrefs: false,
      cwd: tmp, spawn: completedFlowSpawner(), now: NOW,
      settle: { attempts: 1, delayMs: 0 }, headlessIdleMs: 0,
    });
    assert.equal(result.milestoneId, "M042");
    assert.ok(result.postSync !== null && result.postSync.ran);
    if (result.postSync !== null && result.postSync.ran) assert.equal(result.postSync.kind, "synced");
    const out = await readFile(htmlPath, "utf8");
    assert.ok(out.includes("<dt>gsd milestone</dt><dd>M042</dd>"));
    assert.equal(out.includes('<code class="status">[]</code>'), false); // completion sweep painted everything
  });

  test("a sync failure is non-fatal: build result unchanged, postSync reports the error", async () => {
    const { tmp, htmlPath } = await makeProject();
    let queries = 0;
    const spawner: Spawner = async (_cmd, args) => {
      if (args.includes("new-milestone")) return { exitCode: 0, stdout: "", stderr: "" };
      queries += 1;
      // Query 1 is the baseline (pre-new-milestone, no completion yet — see
      // completedFlowSpawner's note above on why baseline must differ from
      // what follows). Query 2 is the settle query and reports completion,
      // so lastCompletedMilestone drift is visible and no auto-chain
      // relaunch fires. Query 3 is the sync-phase query and blows up.
      if (queries >= 3) throw new Error("query exploded mid-sync");
      if (queries === 1) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ state: { phase: "idle", lastCompletedMilestone: null }, cost: { total: 0 } }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ state: { phase: "idle", lastCompletedMilestone: { id: "M042", title: "Minimal Plan" } }, cost: { total: 1 } }),
        stderr: "",
      };
    };
    const result = await runBuild(htmlPath, {
      auto: true, force: true, applyPrefs: false,
      cwd: tmp, spawn: spawner, now: NOW,
      settle: { attempts: 1, delayMs: 0 }, headlessIdleMs: 0,
    });
    assert.equal(result.milestoneId, "M042"); // build outcome intact
    assert.ok(result.postSync !== null && result.postSync.ran === false);
  });
});
