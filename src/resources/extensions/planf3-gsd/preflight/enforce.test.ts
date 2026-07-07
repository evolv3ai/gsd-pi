import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeVerdict, signOff, checkPresetsGate } from "./enforce.js";
import { writePresets } from "./presets-file.js";
import { projectionHash } from "./hash.js";
import type { PresetsRecord, ProjectionResult } from "./types.js";

const PROJECTION: ProjectionResult = {
  buckets: { planning: "claude-code/claude-fable-5" },
  verificationCommands: ["pnpm typecheck"],
  sources: { planning: "plan" },
  allModelIds: [],
};

function recordWith(overrides: Partial<NonNullable<PresetsRecord["approval"]>> = {}, probes: PresetsRecord["probes"] = []): PresetsRecord {
  return {
    schemaVersion: 1,
    approval: {
      approvedAt: "2026-07-06T05:00:00Z",
      approvedBy: { model: "claude-code/claude-fable-5", authMode: "subscription" },
      note: null,
      approvalHash: projectionHash(PROJECTION),
      projectedFrom: "specs/minimal.html",
      ...overrides,
    },
    history: [],
    stages: {
      orchestrator: null,
      gsdBuild: {
        binary: "gsd",
        version: null,
        // The recorded bucket rows are the approval's rendered surface —
        // configDrift diffs current projection against THESE.
        buckets: [{ bucket: "planning", model: "claude-code/claude-fable-5", source: "plan", status: "configured" }],
        verificationCommands: ["pnpm typecheck"],
      },
      exportStage: { generatorVersion: "0.0.0-test" },
      project: { root: ".", branch: null },
    },
    product: [],
    probes,
  };
}

describe("computeVerdict — the three-distinction contract (spec §11.3)", () => {
  test("same plan re-signed → same hash → ok", () => {
    const v = computeVerdict(recordWith(), { projection: PROJECTION, planPath: "specs/minimal.html", probes: [] });
    assert.equal(v.verdict, "ok");
    assert.deepEqual(v.drift, []);
  });

  test("out-of-band PREFERENCES edit → config-drift", () => {
    const edited: ProjectionResult = { ...PROJECTION, buckets: { planning: "claude-code/claude-haiku-4-5" } };
    const v = computeVerdict(recordWith(), { projection: edited, planPath: "specs/minimal.html", probes: [] });
    assert.equal(v.verdict, "drift");
    assert.deepEqual(v.drift, [{
      kind: "config", field: "buckets.planning",
      approved: "claude-code/claude-fable-5", current: "claude-code/claude-haiku-4-5",
    }]);
  });

  test("plan changed (projectedFrom mismatch) → unapproved, NOT drift", () => {
    const v = computeVerdict(recordWith(), { projection: PROJECTION, planPath: "specs/other.html", probes: [] });
    assert.equal(v.verdict, "unapproved");
    assert.match(v.reason, /never signed/);
  });

  test("no record / bare-signed record vs plan build → unapproved", () => {
    assert.equal(computeVerdict(null, { projection: PROJECTION, planPath: null, probes: [] }).verdict, "unapproved");
    const bare = recordWith({ projectedFrom: null });
    assert.equal(computeVerdict(bare, { projection: PROJECTION, planPath: "specs/minimal.html", probes: [] }).verdict, "unapproved");
  });

  test("probe regression → probe-drift; sign-off-time-failing probe does NOT flip", () => {
    const rec = recordWith({}, [
      { target: "openrouter", tier: "auth", verdict: "ok", detail: "HTTP 200", checkedAt: "t0" },
      { target: "github", tier: "auth", verdict: "failed", detail: "gh auth status exit 1", checkedAt: "t0" },
    ]);
    const regressed = computeVerdict(rec, {
      projection: PROJECTION, planPath: "specs/minimal.html",
      probes: [{ target: "openrouter", tier: "auth", verdict: "failed", detail: "auth rejected (HTTP 401)", checkedAt: "t1" }],
    });
    assert.equal(regressed.verdict, "drift");
    assert.deepEqual(regressed.drift, [{ kind: "probe", field: "openrouter", approved: "ok", current: "failed" }]);
    const stillBroken = computeVerdict(rec, {
      projection: PROJECTION, planPath: "specs/minimal.html",
      probes: [{ target: "github", tier: "auth", verdict: "failed", detail: "gh auth status exit 1", checkedAt: "t1" }],
    });
    assert.equal(stillBroken.verdict, "ok");
  });

  test("verification-commands-only drift cites the approved list (polish #15)", () => {
    const edited: ProjectionResult = { ...PROJECTION, verificationCommands: ["pnpm typecheck", "pnpm lint"] };
    const v = computeVerdict(recordWith(), { projection: edited, planPath: "specs/minimal.html", probes: [] });
    assert.equal(v.verdict, "drift");
    assert.deepEqual(v.drift, [{
      kind: "config", field: "verification_commands",
      approved: "pnpm typecheck", current: "pnpm typecheck, pnpm lint",
    }]);
  });

  test("legacy record without retained commands falls back to (as approved)", () => {
    const legacy = recordWith();
    delete legacy.stages.gsdBuild.verificationCommands;
    const edited: ProjectionResult = { ...PROJECTION, verificationCommands: ["pnpm lint"] };
    const v = computeVerdict(legacy, { projection: edited, planPath: "specs/minimal.html", probes: [] });
    assert.deepEqual(v.drift, [{
      kind: "config", field: "verification_commands",
      approved: "(as approved)", current: "pnpm lint",
    }]);
  });
});

describe("signOff", () => {
  test("binds signer identity + note; supersedes previous approval into history", () => {
    const prev = recordWith({ approvalHash: "oldhash" });
    const next = signOff({
      base: { ...recordWith(), approval: null },
      previous: prev,
      facts: { host: "claude-code", model: "claude-code/claude-fable-5", authMode: "subscription", skills: [] },
      note: "switching to subscription builds",
      projectedFrom: "specs/minimal.html",
      approvalHash: projectionHash(PROJECTION),
      now: () => "2026-07-06T06:00:00Z",
    });
    assert.equal(next.approval?.approvedAt, "2026-07-06T06:00:00Z");
    assert.deepEqual(next.approval?.approvedBy, { model: "claude-code/claude-fable-5", authMode: "subscription" });
    assert.equal(next.approval?.note, "switching to subscription builds");
    assert.equal(next.approval?.approvalHash, projectionHash(PROJECTION));
    assert.equal(next.history.length, 1);
    assert.equal(next.history[0].approvalHash, "oldhash");
    assert.equal(next.history[0].supersededAt, "2026-07-06T06:00:00Z");
  });
});

describe("checkPresetsGate (build-time, disk-only)", () => {
  async function scaffold(withApproval: boolean, bucket = "claude-code/claude-fable-5"): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), "planf3-gate-"));
    await mkdir(join(tmp, ".gsd"), { recursive: true });
    await writeFile(join(tmp, ".gsd", "PREFERENCES.md"), `---\nversion: 1\nmodels:\n  planning: ${bucket}\nverification_commands:\n  - pnpm typecheck\n---\n`, "utf8");
    await mkdir(join(tmp, "specs"), { recursive: true });
    await writeFile(join(tmp, "specs", "minimal.html"), "<html><body><header><h1>M</h1></header></body></html>", "utf8");
    if (withApproval) {
      const rec = recordWith({ projectedFrom: join(tmp, "specs", "minimal.html") });
      await writePresets(tmp, rec);
    }
    return tmp;
  }

  test("absent record → refusal naming the exact rerun command; forced → presets 'forced'", async () => {
    const tmp = await scaffold(false);
    const html = join(tmp, "specs", "minimal.html");
    const gate = await checkPresetsGate(tmp, html, { force: false, globalPrefsPath: join(tmp, "nonexistent-global.md") });
    assert.equal(gate.presets, "absent");
    assert.match(gate.refusal ?? "", new RegExp(`/planf3-gsd-preflight ${html.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const forced = await checkPresetsGate(tmp, html, { force: true, globalPrefsPath: join(tmp, "nonexistent-global.md") });
    assert.equal(forced.presets, "forced");
    assert.equal(forced.refusal, null);
  });

  test("matching record → ok with the hash; drifted prefs → drift refusal with field diff", async () => {
    const tmp = await scaffold(true);
    const html = join(tmp, "specs", "minimal.html");
    const ok = await checkPresetsGate(tmp, html, { force: false, globalPrefsPath: join(tmp, "nonexistent-global.md") });
    assert.equal(ok.presets, "ok");
    assert.equal(ok.presetsHash, projectionHash(PROJECTION));
    // out-of-band edit
    await writeFile(join(tmp, ".gsd", "PREFERENCES.md"), `---\nversion: 1\nmodels:\n  planning: claude-code/claude-haiku-4-5\nverification_commands:\n  - pnpm typecheck\n---\n`, "utf8");
    const drifted = await checkPresetsGate(tmp, html, { force: false, globalPrefsPath: join(tmp, "nonexistent-global.md") });
    assert.equal(drifted.presets, "drift");
    assert.match(drifted.refusal ?? "", /buckets\.planning/);
    assert.match(drifted.refusal ?? "", /claude-code\/claude-fable-5 → claude-code\/claude-haiku-4-5/);
  });

  test("corrupt PRESETS.md: refusal names the file; --force proceeds with a null hash", async () => {
    const tmp = await scaffold(false);
    await writeFile(join(tmp, "specs", "PRESETS.md"), "not a presets file\n", "utf8");
    const html = join(tmp, "specs", "minimal.html");
    const gate = await checkPresetsGate(tmp, html, { force: false, globalPrefsPath: join(tmp, "nonexistent-global.md") });
    assert.equal(gate.presets, "absent");
    assert.match(gate.refusal ?? "", /PRESETS\.md is unreadable \(/);
    assert.match(gate.refusal ?? "", /planf3-gsd-preflight/);
    const forced = await checkPresetsGate(tmp, html, { force: true, globalPrefsPath: join(tmp, "nonexistent-global.md") });
    assert.equal(forced.presets, "forced");
    assert.equal(forced.presetsHash, null);
    assert.equal(forced.refusal, null);
  });

  test("corrupt GLOBAL PREFERENCES.md degrades to absent for the gate (symmetric to project-side)", async () => {
    const tmp = await scaffold(true);
    const html = join(tmp, "specs", "minimal.html");
    const globalPrefs = join(tmp, "corrupt-global.md");
    await writeFile(globalPrefs, "---\nunclosed frontmatter\n", "utf8");
    const gate = await checkPresetsGate(tmp, html, { force: false, globalPrefsPath: globalPrefs });
    assert.equal(gate.presets, "ok", "corrupt global prefs must degrade to absent, not crash or refuse");
  });

  test("F1b: absenceReason discriminates no-record vs unsigned-projection", async () => {
    // No record on disk → absenceReason "no-record".
    const tmpA = await scaffold(false);
    const htmlA = join(tmpA, "specs", "minimal.html");
    const noRecord = await checkPresetsGate(tmpA, htmlA, { force: false, globalPrefsPath: join(tmpA, "no-global.md") });
    assert.equal(noRecord.presets, "absent");
    assert.equal(noRecord.absenceReason, "no-record");

    // Record exists but projectedFrom differs → absenceReason "unsigned-projection".
    const tmpB = await scaffold(true);           // scaffold signs projectedFrom = join(tmpB, "specs", "minimal.html")
    const otherHtml = join(tmpB, "specs", "other.html");
    await writeFile(otherHtml, "<html><body><header><h1>O</h1></header></body></html>", "utf8");
    const unsigned = await checkPresetsGate(tmpB, otherHtml, { force: false, globalPrefsPath: join(tmpB, "no-global.md") });
    assert.equal(unsigned.presets, "absent");
    assert.equal(unsigned.absenceReason, "unsigned-projection");
  });

  test("F1: gate accepts a relative htmlPath even when the record was signed with an absolute path", async () => {
    const tmp = await scaffold(true);      // scaffold signs projectedFrom = ABSOLUTE join(tmp, "specs", "minimal.html")
    const relative = join("specs", "minimal.html");
    const gate = await checkPresetsGate(tmp, relative, { force: false, globalPrefsPath: join(tmp, "no-global.md") });
    assert.equal(gate.presets, "ok", "same file, gate opens regardless of relative-vs-absolute spelling");
    assert.equal(gate.absenceReason, undefined);
  });
});
