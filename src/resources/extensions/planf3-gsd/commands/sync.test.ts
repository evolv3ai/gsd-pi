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

async function makeProject(milestoneId: string | null = "M042", mapping?: unknown): Promise<{ tmp: string; htmlPath: string; manifestPath: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-sync-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  const htmlPath = join(tmp, "specs", "minimal.html");
  const manifestPath = join(tmp, "specs", "minimal.manifest.json");
  await writeFile(htmlPath, FIXTURE, "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      planf3: { htmlPath: "specs/minimal.html" },
      gsd: { specPath: "specs/minimal.gsd.md", milestoneId, mode: "auto" },
      ...(mapping !== undefined ? { mapping } : {}),
    }),
    "utf8",
  );
  return { tmp, htmlPath, manifestPath };
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

const M4_MAPPING = {
  phases: [
    { title: "Phase 1: Setup", pf3Id: "PF3-P1", gsdSlice: null, tasks: [{ title: "1. Scaffolding", pf3Id: "PF3-P1-T1", gsdTask: null }] },
    { title: "Phase 2: Wire-up", pf3Id: "PF3-P2", gsdSlice: null, tasks: [{ title: "2. Hooking up", pf3Id: "PF3-P2-T1", gsdTask: null }] },
  ],
};

describe("runSync — M4 correlation + binding persistence", () => {
  test("tag rung: invented slice title with [PF3-P2] paints phase 2 and persists the binding", async () => {
    const { tmp, htmlPath, manifestPath } = await makeProject("M042", M4_MAPPING);
    const spawn = snapshotSpawner({
      phase: "executing",
      activeMilestone: { id: "M042", title: "Minimal Plan" },
      activeSlice: { id: "S7", title: "Invented Slice Name [PF3-P2]" },
    });
    const r = await runSync(null, false, { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "synced");
    assert.deepEqual(r.bound, ["bound slice PF3-P2 ↔ S7"]);
    const out = await readFile(htmlPath, "utf8");
    assert.ok(out.includes('<h3><code class="status">[wip]</code> Phase 2: Wire-up</h3>'));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.mapping.phases[1].gsdSlice, "S7");
  });

  test("persisted binding wins on the next run without re-matching or re-persisting", async () => {
    const boundMapping = {
      phases: [
        M4_MAPPING.phases[0],
        { ...M4_MAPPING.phases[1], gsdSlice: "S7" },
      ],
    };
    const { tmp, manifestPath } = await makeProject("M042", boundMapping);
    const before = await readFile(manifestPath, "utf8");
    const spawn = snapshotSpawner({
      phase: "executing",
      activeMilestone: { id: "M042", title: "Minimal Plan" },
      activeSlice: { id: "S7", title: "Renamed Again Completely" },
    });
    const r = await runSync(null, false, { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "synced");
    assert.deepEqual(r.bound, []);
    assert.equal(await readFile(manifestPath, "utf8"), before); // no manifest rewrite
  });

  test("dry-run persists neither HTML nor bindings", async () => {
    const { tmp, htmlPath, manifestPath } = await makeProject("M042", M4_MAPPING);
    const before = await readFile(manifestPath, "utf8");
    const spawn = snapshotSpawner({
      phase: "executing",
      activeMilestone: { id: "M042", title: "Minimal Plan" },
      activeSlice: { id: "S7", title: "Whatever [PF3-P2]" },
    });
    const r = await runSync(null, true, { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "dry-run");
    assert.equal(await readFile(htmlPath, "utf8"), FIXTURE);
    assert.equal(await readFile(manifestPath, "utf8"), before);
  });

  test("binding-only run: markers already correct still persists the new binding (no-change kind)", async () => {
    const { tmp, manifestPath } = await makeProject("M042", M4_MAPPING);
    // Warm up the metadata rows first (fresh fixtures have none, so the very
    // first sync of any project always writes them and reports "synced" —
    // that's unrelated M3 behavior). No active slice/task here, so nothing
    // is resolved or bound during warm-up.
    const warmup = snapshotSpawner({ phase: "executing", activeMilestone: { id: "M042", title: "Minimal Plan" } });
    const w = await runSync(null, false, { cwd: tmp, spawn: warmup, now: NOW });
    assert.equal(w.kind, "synced");
    assert.deepEqual(w.bound, []);

    // Phase 1 is already [wip] in the fixture; slice resolves there via tag.
    const spawn = snapshotSpawner({
      phase: "executing",
      activeMilestone: { id: "M042", title: "Minimal Plan" },
      activeSlice: { id: "S1", title: "Invented [PF3-P1]" },
    });
    const r = await runSync(null, false, { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "no-change");
    assert.deepEqual(r.bound, ["bound slice PF3-P1 ↔ S1"]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.mapping.phases[0].gsdSlice, "S1");
  });

  test("title-rung success also persists a binding (rung 3 binds)", async () => {
    const { tmp, manifestPath } = await makeProject("M042", M4_MAPPING);
    const spawn = snapshotSpawner({
      phase: "executing",
      activeMilestone: { id: "M042", title: "Minimal Plan" },
      activeSlice: { id: "S2", title: "Wire-up" },
    });
    const r = await runSync(null, false, { cwd: tmp, spawn, now: NOW });
    assert.equal(r.kind, "synced");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.mapping.phases[1].gsdSlice, "S2");
  });
});

describe("runSync — completion sweep validation upkeep (F6.0-8)", () => {
  test("completion sync upserts validation.lastStatus=passed + lastSyncedAt, and says so", async () => {
    const { tmp, manifestPath } = await makeProject();
    const r = await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: NOW });
    assert.equal(r.kind, "synced");
    assert.ok(r.bound.includes("validation.lastStatus → passed"), `summary must mention the upsert: ${JSON.stringify(r.bound)}`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.validation.lastStatus, "passed");
    assert.equal(manifest.validation.lastSyncedAt, "2026-07-11T09:00:00Z");
  });

  test("idempotent: second completion sync leaves the manifest byte-identical (no re-write)", async () => {
    const { tmp, manifestPath } = await makeProject();
    await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: NOW });
    const afterFirst = await readFile(manifestPath, "utf8");
    const r2 = await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: () => "2026-07-12T00:00:00Z" });
    assert.equal(r2.kind, "no-change");
    assert.equal(await readFile(manifestPath, "utf8"), afterFirst, "already-passed must not rewrite (lastSyncedAt frozen)");
  });

  test("dry-run on a completed milestone persists nothing", async () => {
    const { tmp, manifestPath } = await makeProject();
    const before = await readFile(manifestPath, "utf8");
    const r = await runSync(null, true, { cwd: tmp, spawn: completedSpawn, now: NOW });
    assert.equal(r.kind, "dry-run");
    assert.equal(await readFile(manifestPath, "utf8"), before);
  });

  test("non-completed sync never touches validation", async () => {
    const { tmp, manifestPath } = await makeProject();
    await runSync("specs/minimal.html", false, { cwd: tmp, spawn: activeSpawn, now: NOW });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.validation, undefined);
  });

  test("a pre-existing validation object is upserted in place (lastStatus running → passed), other keys kept", async () => {
    const { tmp, manifestPath } = await makeProject();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.validation = { lastStatus: "running", lastRunAt: "2026-07-11T08:00:00Z" };
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await runSync(null, false, { cwd: tmp, spawn: completedSpawn, now: NOW });
    const after = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(after.validation.lastStatus, "passed");
    assert.equal(after.validation.lastRunAt, "2026-07-11T08:00:00Z", "unrelated validation keys survive");
    assert.equal(after.validation.lastSyncedAt, "2026-07-11T09:00:00Z");
  });
});
