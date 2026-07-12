import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlanf3Skill, SKILL_MISSING_GUIDANCE, buildPlanPrompt, runPlan } from "./plan.js";

async function makeSkillDir(root: string): Promise<string> {
  const dir = join(root, ".claude", "skills", "planf3");
  await mkdir(dir, { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  await writeFile(skillPath, "# planf3\n", "utf8");
  return skillPath;
}

describe("discoverPlanf3Skill", () => {
  test("project-local skill wins over home", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "planf3-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "planf3-home-"));
    const local = await makeSkillDir(cwd);
    await makeSkillDir(home);
    assert.equal(await discoverPlanf3Skill({ cwd, homeDir: home }), local);
  });

  test("falls back to homeDir when the project has no skill", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "planf3-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "planf3-home-"));
    const homeSkill = await makeSkillDir(home);
    assert.equal(await discoverPlanf3Skill({ cwd, homeDir: home }), homeSkill);
  });

  test("neither location → null", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "planf3-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "planf3-home-"));
    assert.equal(await discoverPlanf3Skill({ cwd, homeDir: home }), null);
  });

  test("guidance names both install locations", () => {
    assert.match(SKILL_MISSING_GUIDANCE, /\.\/\.claude\/skills\/planf3/);
    assert.match(SKILL_MISSING_GUIDANCE, /~\/\.claude\/skills\/planf3/);
  });
});

describe("buildPlanPrompt", () => {
  const base = {
    skillPath: "/home/u/.claude/skills/planf3/SKILL.md",
    request: "add   dark mode",
    questionable: false,
  };

  test("export chain carries all six required elements", () => {
    const prompt = buildPlanPrompt({ ...base, chain: { target: "export" } });
    assert.ok(prompt.includes(base.skillPath));                  // 1: skill path
    assert.ok(prompt.includes("USER_PROMPT: add   dark mode")); // 2: verbatim, spacing intact
    assert.ok(prompt.includes("QUESTIONABLE: false"));          // 3
    assert.ok(prompt.includes("specs/"));                       // 4
    assert.ok(prompt.includes("planf3_gsd_export"));            // 5: chain target
    assert.ok(!prompt.includes("planf3_gsd_build"));            //    build subsumes export — never both
    assert.match(prompt, /report back/i);                       // 6
  });

  test("build chain embeds the flag values and targets the build tool", () => {
    const prompt = buildPlanPrompt({
      ...base,
      questionable: true,
      chain: { target: "build", flags: { auto: false, applyPrefs: false, force: true, allowUnsafeStep: true } },
    });
    assert.ok(prompt.includes("QUESTIONABLE: true"));
    assert.ok(prompt.includes("planf3_gsd_build"));
    assert.ok(!prompt.includes("planf3_gsd_export"));
    assert.ok(prompt.includes("auto=false"));
    assert.ok(prompt.includes("applyPrefs=false"));
    assert.ok(prompt.includes("force=true"));
    assert.ok(prompt.includes("allowUnsafeStep=true"));
    assert.match(prompt, /milestone/i);                         // 6: report the milestone ID
  });

  test("default /run flags serialize as the safe defaults", () => {
    const prompt = buildPlanPrompt({
      ...base,
      chain: { target: "build", flags: { auto: true, applyPrefs: true, force: false, allowUnsafeStep: false } },
    });
    assert.ok(prompt.includes("auto=true"));
    assert.ok(prompt.includes("applyPrefs=true"));
    assert.ok(prompt.includes("force=false"));
    assert.ok(prompt.includes("allowUnsafeStep=false"));
  });

  test("export chain: fallback line for hosts that don't surface pi-session tools", () => {
    const prompt = buildPlanPrompt({ ...base, chain: { target: "export" } });
    assert.ok(prompt.includes("gsd --print '/planf3-gsd-export"));
    assert.ok(prompt.includes("planf3_gsd_export tool is not in your available tools"));
  });

  test("build chain: fallback command renders with only --auto for /run defaults", () => {
    const prompt = buildPlanPrompt({
      ...base,
      chain: { target: "build", flags: { auto: true, applyPrefs: true, force: false, allowUnsafeStep: false } },
    });
    assert.ok(prompt.includes("gsd --print '/planf3-gsd-build <path-to-plan.html> --auto'"));
    assert.ok(!prompt.includes("--no-prefs"));
  });

  test("build chain: fallback command includes --no-prefs --force --step-unsafe, not --auto", () => {
    const prompt = buildPlanPrompt({
      ...base,
      chain: { target: "build", flags: { auto: false, applyPrefs: false, force: true, allowUnsafeStep: true } },
    });
    assert.ok(prompt.includes("--no-prefs --force --step-unsafe"));
    assert.ok(!prompt.includes("'/planf3-gsd-build <path-to-plan.html> --auto"));
  });

  test("build chain: fallback command has no trailing space when all flags are off", () => {
    const prompt = buildPlanPrompt({
      ...base,
      chain: { target: "build", flags: { auto: false, applyPrefs: true, force: false, allowUnsafeStep: false } },
    });
    assert.ok(prompt.includes("gsd --print '/planf3-gsd-build <path-to-plan.html>'"));
  });
});

describe("runPlan", () => {
  test("missing skill → guidance, no prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "planf3-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "planf3-home-"));
    const outcome = await runPlan({ cwd, homeDir: home, request: "x", questionable: false, chain: { target: "export" } });
    assert.deepEqual(outcome, { ok: false, guidance: SKILL_MISSING_GUIDANCE });
  });

  test("skill present → prompt embeds the discovered path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "planf3-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "planf3-home-"));
    const skillPath = await makeSkillDir(cwd);
    const outcome = await runPlan({ cwd, homeDir: home, request: "ship it", questionable: false, chain: { target: "export" } });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.skillPath, skillPath);
      assert.ok(outcome.prompt.includes(skillPath));
      assert.ok(outcome.prompt.includes("USER_PROMPT: ship it"));
    }
  });
});
