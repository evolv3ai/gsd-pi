import test from "node:test";
import assert from "node:assert/strict";
import type { Skill } from "@gsd/pi-coding-agent";
import {
  detectNewlyInstalledSkills,
  getInstalledSkillNames,
  getInstalledSkills,
  normalizeSkillName,
  resolveInstalledSkill,
  snapshotInstalledSkillNames,
} from "../skills.js";

function makeSkill(name: string, filePath = `/tmp/${name}/SKILL.md`): Skill {
  return {
    name,
    description: `Use for ${name}.`,
    filePath,
    baseDir: `/tmp/${name}`,
    source: "user",
    sourceInfo: {
      path: filePath,
      source: "local",
      scope: "user",
      origin: "top-level",
      baseDir: `/tmp/${name}`,
    },
    disableModelInvocation: false,
  };
}

test("normalizeSkillName lowercases and trims", () => {
  assert.equal(normalizeSkillName("  React-Best  "), "react-best");
});

test("getInstalledSkills returns explicit override", () => {
  const skills = [makeSkill("alpha"), makeSkill("beta")];
  assert.deepEqual(getInstalledSkills(skills).map((s) => s.name), ["alpha", "beta"]);
});

test("snapshotInstalledSkillNames and detectNewlyInstalledSkills diff normalized names", () => {
  const baseline = snapshotInstalledSkillNames([makeSkill("alpha")]);
  const added = detectNewlyInstalledSkills(baseline, [makeSkill("alpha"), makeSkill("Beta")]);
  assert.deepEqual(added, ["beta"]);
});

test("getInstalledSkillNames maps skill names", () => {
  assert.deepEqual(getInstalledSkillNames([makeSkill("tdd")]), ["tdd"]);
});

test("resolveInstalledSkill matches installed catalog by name", () => {
  const skills = [makeSkill("react", "/home/user/.gsd/agent/skills/react/SKILL.md")];
  const result = resolveInstalledSkill("react", "/project", skills);
  assert.equal(result.skill?.name, "react");
  assert.equal(result.resolvedPath, "/home/user/.gsd/agent/skills/react/SKILL.md");
});
