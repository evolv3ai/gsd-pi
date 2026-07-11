import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "./sync.js";
import type { Spawner } from "../gsd/headless-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, "..", "fixtures", "minimal-plan.html"), "utf8");
const NOW = () => "2026-07-11T09:00:00Z";

async function makeProject(milestoneId: string | null = "M042"): Promise<{ tmp: string; htmlPath: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-sync-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  const htmlPath = join(tmp, "specs", "minimal.html");
  await writeFile(htmlPath, FIXTURE, "utf8");
  await writeFile(
    join(tmp, "specs", "minimal.manifest.json"),
    JSON.stringify({ planf3: { htmlPath: "specs/minimal.html" }, gsd: { specPath: "specs/minimal.gsd.md", milestoneId, mode: "auto" } }),
    "utf8",
  );
  return { tmp, htmlPath };
}

function snapshotSpawner(state: Record<string, unknown>, sessionId: string | null = null): Spawner {
  return async (_cmd, args) => {
    assert.deepEqual(args, ["headless", "--output-format", "json", "query"]);
    return { exitCode: 0, stdout: JSON.stringify({ state, sessionId, cost: { total: 1 } }), stderr: "" };
  };
}

const completedSpawn = snapshotSpawner(
  { phase: "idle", lastCompletedMilestone: { id: "M042", title: "Minimal Plan" } },
  "sess-9",
);
const activeSpawn = snapshotSpawner({
  phase: "executing",
  activeMilestone: { id: "M042", title: "Minimal Plan" },
  activeSlice: { id: "S2", title: "Wire-up" },
});
const foreignSpawn = snapshotSpawner({ phase: "executing", activeMilestone: { id: "M999", title: "Other" } });

describe("runSync", () => {
  test("completion snapshot: writes all markers [x] + metadata rows", async () => {
    const { tmp, htmlPath } = await makeProject();
    const r = await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: NOW });
    assert.equal(r.kind, "synced");
    assert.equal(r.applied.length, 8);
    const out = await readFile(htmlPath, "utf8");
    assert.equal(/\[wip\]|\[f\]|<code class="status">\[\]<\/code>/.test(out), false); // nothing below done left
    assert.ok(out.includes("<dt>gsd milestone</dt><dd>M042</dd>"));
    assert.ok(out.includes("<dt>gsd session</dt><dd>sess-9</dd>"));
    assert.ok(out.includes("2026-06-22T10:00:00-05:00, 2026-07-11T09:00:00Z"));
  });

  test("idempotent: second run reports no-change and file is byte-identical", async () => {
    const { tmp, htmlPath } = await makeProject();
    await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: NOW });
    const afterFirst = await readFile(htmlPath, "utf8");
    const r2 = await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: () => "2026-07-12T00:00:00Z" });
    assert.equal(r2.kind, "no-change");
    assert.equal(await readFile(htmlPath, "utf8"), afterFirst);
  });

  test("--dry-run: file untouched, message lists the would-be changes", async () => {
    const { tmp, htmlPath } = await makeProject();
    const r = await runSync(null, true, { cwd: tmp, spawn: completedSpawn, now: NOW });
    assert.equal(r.kind, "dry-run");
    assert.equal(await readFile(htmlPath, "utf8"), FIXTURE);
    assert.ok(r.message.includes("[wip] → [x]"));
    assert.ok(r.message.includes("gsd milestone = M042"));
  });

  test("active slice snapshot: paints the matched phase [wip]", async () => {
    const { tmp, htmlPath } = await makeProject();
    const r = await runSync("specs/minimal.html", false, { cwd: tmp, spawn: activeSpawn, now: NOW });
    assert.equal(r.kind, "synced");
    const out = await readFile(htmlPath, "utf8");
    assert.ok(out.includes('<h3><code class="status">[wip]</code> Phase 2: Wire-up</h3>'));
  });

  test("unmatched active ref is reported, never invents [f]", async () => {
    const { tmp, htmlPath } = await makeProject();
    const spawn = snapshotSpawner({
      phase: "executing",
      activeMilestone: { id: "M042", title: "Minimal Plan" },
      activeSlice: { id: "S9", title: "Deployment" },
      blockers: [{ reason: "stuck" }],
    });
    const r = await runSync(null, false, { cwd: tmp, spawn, now: NOW });
    assert.deepEqual(r.unmatched, ["Deployment"]);
    const out = await readFile(htmlPath, "utf8");
    assert.equal(out.includes("[f]</code> Phase"), false); // no phase turned [f]
    assert.ok(r.message.includes('unmatched: "Deployment"'));
  });

  test("foreign milestone: not observable, nothing written, not an error", async () => {
    const { tmp, htmlPath } = await makeProject();
    const r = await runSync(null, false, { cwd: tmp, spawn: foreignSpawn, now: NOW });
    assert.equal(r.kind, "not-observable");
    assert.match(r.message, /not observable/);
    assert.equal(await readFile(htmlPath, "utf8"), FIXTURE);
  });

  test("no manifest: not-located, query never spawned", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-sync-empty-"));
    let spawned = false;
    const spawn: Spawner = async () => { spawned = true; return { exitCode: 0, stdout: "{}", stderr: "" }; };
    const r = await runSync(null, false, { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "not-located");
    assert.equal(spawned, false);
  });

  test("manifest without milestoneId: not-located", async () => {
    const { tmp } = await makeProject(null);
    const r = await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: NOW });
    assert.equal(r.kind, "not-located");
  });

  test("plan changed under us: aborts with no write", async () => {
    const { tmp, htmlPath } = await makeProject();
    // Strip one marker so the raw occurrence count disagrees with the parse-side count.
    const mangled = FIXTURE.replace('<code class="status">[f]</code> First attempt failed.', "First attempt failed.");
    await writeFile(htmlPath, mangled, "utf8");
    const r = await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: NOW });
    assert.equal(r.kind, "aborted");
    assert.equal(await readFile(htmlPath, "utf8"), mangled);
  });

  test("query failure surfaces as a friendly thrown error", async () => {
    const { tmp } = await makeProject();
    const spawn: Spawner = async () => { const e = new Error("spawn gsd ENOENT") as Error & { code?: string; syscall?: string }; e.code = "ENOENT"; e.syscall = "spawn"; throw e; };
    await assert.rejects(() => runSync(null, false, { cwd: tmp, spawn, now: NOW }), /gsd binary not found/);
  });
});
