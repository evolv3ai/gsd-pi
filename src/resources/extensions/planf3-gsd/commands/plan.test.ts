import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlanf3Skill, SKILL_MISSING_GUIDANCE } from "./plan.js";

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
