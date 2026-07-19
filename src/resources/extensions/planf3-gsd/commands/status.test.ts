import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runStatus, runStatusReport, STALE_NUDGE } from "./status.js";
import type { Spawner } from "../gsd/headless-runner.js";

const here = dirname(fileURLToPath(import.meta.url));

function snapshotSpawner(state: Record<string, unknown>, sessionId: string | null = null): Spawner {
  return async (_cmd, args) => {
    assert.deepEqual(args, ["headless", "--output-format", "json", "query"]);
    return { exitCode: 0, stdout: JSON.stringify({ state, sessionId, cost: { total: 1 } }), stderr: "" };
  };
}

const NOW = () => "2026-07-11T09:00:00Z";

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

  const COMPLETED_SNAPSHOT = JSON.stringify({
    state: { phase: "idle", activeMilestone: null, lastCompletedMilestone: { id: "M042", title: "Minimal Plan" } },
    next: null,
    cost: { total: 3.2 },
  });
  const completedSpawn: Spawner = async () => ({ exitCode: 0, stdout: COMPLETED_SNAPSHOT, stderr: "" });

  async function writeManifest(tmp: string, milestoneId: string | null): Promise<void> {
    await mkdir(join(tmp, "specs"), { recursive: true });
    await writeFile(
      join(tmp, "specs", "minimal.manifest.json"),
      JSON.stringify({
        planf3: { htmlPath: "specs/minimal.html" },
        gsd: { specPath: "specs/minimal.gsd.md", milestoneId, mode: "auto" },
      }),
      "utf8",
    );
  }

  test("backfills one status completion row for a bridge-built milestone", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-status-done-"));
    await writeManifest(tmp, "M042");

    await runStatus({ binary: "gsd", cwd: tmp, spawn: completedSpawn, now: () => "2026-07-06T02:00:00Z" });

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.event, "status");
    assert.equal(row.milestoneId, "M042");
    assert.equal(row.loggedAt, "2026-07-06T02:00:00Z");
    assert.equal(row.htmlPath, "specs/minimal.html");
    assert.equal(row.specPath, "specs/minimal.gsd.md");
    assert.equal(row.mode, "auto");
    assert.equal(row.phase, "idle");
    assert.equal(row.cost, 3.2);
  });

  test("does not duplicate the completion row on repeated status calls", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-status-dedup-"));
    await writeManifest(tmp, "M042");

    await runStatus({ binary: "gsd", cwd: tmp, spawn: completedSpawn });
    await runStatus({ binary: "gsd", cwd: tmp, spawn: completedSpawn });

    const lines = (await readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
  });

  test("no manifest match (foreign milestone) and no completion: no row, no throw", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-status-foreign-"));
    await writeManifest(tmp, "M999"); // different milestone — not ours

    await runStatus({ binary: "gsd", cwd: tmp, spawn: completedSpawn });

    // also fine with no specs/ dir at all and nothing completed
    const bare = await mkdtemp(join(tmpdir(), "planf3-gsd-status-bare-"));
    const idleSpawn: Spawner = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: { phase: "idle" }, next: null, cost: { total: 0 } }), stderr: "" });
    await runStatus({ binary: "gsd", cwd: bare, spawn: idleSpawn });

    await assert.rejects(() => readFile(join(tmp, ".gsd", "planf3-gsd-evals.jsonl"), "utf8"));
    await assert.rejects(() => readFile(join(bare, ".gsd", "planf3-gsd-evals.jsonl"), "utf8"));
  });
});

const FIXTURE = readFileSync(join(here, "..", "fixtures", "minimal-plan.html"), "utf8");
// A "pristine" variant: no marker anywhere above todo.
const PRISTINE = FIXTURE
  .replaceAll('<code class="status">[x]</code>', '<code class="status">[]</code>')
  .replaceAll('<code class="status">[wip]</code>', '<code class="status">[]</code>')
  .replaceAll('<code class="status">[f]</code>', '<code class="status">[]</code>');

async function makeStatusProject(html: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-status-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  await writeFile(join(tmp, "specs", "minimal.html"), html, "utf8");
  await writeFile(
    join(tmp, "specs", "minimal.manifest.json"),
    JSON.stringify({ planf3: { htmlPath: "specs/minimal.html" }, gsd: { specPath: "specs/minimal.gsd.md", milestoneId: "M042", mode: "auto" } }),
    "utf8",
  );
  return tmp;
}

const workingState = {
  phase: "executing",
  activeMilestone: { id: "M042", title: "Minimal Plan" },
  progress: { milestones: { done: 0, total: 1 }, slices: { done: 1, total: 2 }, tasks: { done: 3, total: 6 } },
};

describe("runStatusReport — staleness nudge (M4)", () => {
  test("completed units + pristine markers -> nudge", async () => {
    const tmp = await makeStatusProject(PRISTINE);
    const r = await runStatusReport({ cwd: tmp, spawn: snapshotSpawner(workingState), now: NOW });
    assert.equal(r.nudge, STALE_NUDGE);
  });

  test("markers already show done work -> no nudge", async () => {
    const tmp = await makeStatusProject(FIXTURE); // fixture has a [x] item
    const r = await runStatusReport({ cwd: tmp, spawn: snapshotSpawner(workingState), now: NOW });
    assert.equal(r.nudge, null);
  });

  test("zero completed units -> no nudge", async () => {
    const tmp = await makeStatusProject(PRISTINE);
    const idle = { ...workingState, progress: { milestones: { done: 0, total: 1 }, slices: { done: 0, total: 2 }, tasks: { done: 0, total: 6 } } };
    const r = await runStatusReport({ cwd: tmp, spawn: snapshotSpawner(idle), now: NOW });
    assert.equal(r.nudge, null);
  });

  test("no bridge manifest for the active milestone -> no nudge, no error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-status-none-"));
    const r = await runStatusReport({ cwd: tmp, spawn: snapshotSpawner(workingState), now: NOW });
    assert.equal(r.nudge, null);
  });

  test("unreadable HTML -> best-effort null, status still returned", async () => {
    const tmp = await makeStatusProject(PRISTINE);
    await writeFile(join(tmp, "specs", "minimal.html"), "<not really html", "utf8");
    const r = await runStatusReport({ cwd: tmp, spawn: snapshotSpawner(workingState), now: NOW });
    assert.equal(r.status.activeMilestone?.id, "M042");
    // nudge may be null (parse degraded) — the call must simply not throw
  });
});
