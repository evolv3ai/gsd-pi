import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateSyncTarget, manifestPathFor } from "./locate.js";

async function project(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-locate-"));
  await mkdir(join(tmp, "specs"), { recursive: true });
  return tmp;
}

async function writeManifest(tmp: string, name: string, milestoneId: string | null, htmlPath = `specs/${name}.html`): Promise<void> {
  await writeFile(
    join(tmp, "specs", `${name}.manifest.json`),
    JSON.stringify({ planf3: { htmlPath }, gsd: { specPath: `specs/${name}.gsd.md`, milestoneId, mode: "auto" } }),
    "utf8",
  );
}

describe("manifestPathFor", () => {
  test("sibling naming rule matches the exporter", () => {
    assert.equal(manifestPathFor("/w/specs/plan.html"), "/w/specs/plan.manifest.json");
  });
});

describe("locateSyncTarget — explicit path", () => {
  test("resolves relative path against cwd and finds the sibling manifest", async () => {
    const tmp = await project();
    await writeManifest(tmp, "plan", "M042");
    const r = await locateSyncTarget(tmp, "specs/plan.html");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.target.htmlPath, join(tmp, "specs", "plan.html"));
    assert.equal(r.target.manifestPath, join(tmp, "specs", "plan.manifest.json"));
    assert.equal(r.target.milestoneId, "M042");
  });

  test("missing manifest -> build-first error", async () => {
    const tmp = await project();
    const r = await locateSyncTarget(tmp, "specs/plan.html");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /run \/planf3-gsd-build first/);
  });

  test("null milestoneId -> build-first error", async () => {
    const tmp = await project();
    await writeManifest(tmp, "plan", null);
    const r = await locateSyncTarget(tmp, "specs/plan.html");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /milestoneId/);
  });

  test("corrupt manifest (invalid JSON) -> unreadable error, not missing error", async () => {
    const tmp = await project();
    const manifestPath = join(tmp, "specs", "plan.manifest.json");
    await writeFile(manifestPath, "{not json", "utf8");
    const r = await locateSyncTarget(tmp, "specs/plan.html");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /unreadable/);
    assert.doesNotMatch(r.message, /no bridge manifest/);
  });
});

describe("locateSyncTarget — inference (no path)", () => {
  test("zero manifests -> build-first error", async () => {
    const tmp = await project();
    const r = await locateSyncTarget(tmp, null);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /run \/planf3-gsd-build first/);
  });

  test("no specs/ directory at all -> build-first error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gsd-locate-nospecs-"));
    const r = await locateSyncTarget(tmp, null);
    assert.equal(r.ok, false);
  });

  test("exactly one manifest -> used, htmlPath resolved from manifest", async () => {
    const tmp = await project();
    await writeManifest(tmp, "solo", "M007");
    const r = await locateSyncTarget(tmp, null);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.target.htmlPath, join(tmp, "specs", "solo.html"));
    assert.equal(r.target.milestoneId, "M007");
  });

  test("several manifests -> lists candidate HTML paths, no guessing", async () => {
    const tmp = await project();
    await writeManifest(tmp, "alpha", "M001");
    await writeManifest(tmp, "beta", "M002");
    const r = await locateSyncTarget(tmp, null);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /alpha\.html/);
    assert.match(r.message, /beta\.html/);
  });

  test("unreadable manifest is skipped, not fatal", async () => {
    const tmp = await project();
    await writeFile(join(tmp, "specs", "broken.manifest.json"), "{not json", "utf8");
    await writeManifest(tmp, "good", "M003");
    const r = await locateSyncTarget(tmp, null);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.target.milestoneId, "M003");
  });
});
