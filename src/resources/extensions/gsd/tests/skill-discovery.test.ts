import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDiscoveredSkillsFallback,
  clearSkillSnapshot,
  detectNewSkills,
  refreshCatalogForNewSkills,
  snapshotSkills,
} from "../skill-discovery.js";

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "gsd-skill-discovery-"));
}

async function withTempSkillHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousGsdHome = process.env.GSD_HOME;
  const home = makeTempHome();
  process.env.HOME = home;
  process.env.GSD_HOME = join(home, ".gsd");
  try {
    return await fn(home);
  } finally {
    clearSkillSnapshot();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousGsdHome === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = previousGsdHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function writeDiskSkill(root: string, name: string, description = `Use for ${name}.`): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

test("detectNewSkills detects skills added on disk after the baseline snapshot", async () => {
  await withTempSkillHome((home) => {
    const skillsRoot = join(home, ".agents", "skills");
    writeDiskSkill(skillsRoot, "existing-skill");
    snapshotSkills();

    writeDiskSkill(skillsRoot, "new-disk-skill", "New disk skill.");
    const detected = detectNewSkills();

    assert.deepEqual(detected.map(skill => skill.name), ["new-disk-skill"]);
    assert.equal(detected[0].description, "New disk skill.");
    assert.equal(detected[0].location, join(skillsRoot, "new-disk-skill", "SKILL.md"));
  });
});

test("refreshCatalogForNewSkills retries discovery after reload failure", async () => {
  await withTempSkillHome(async (home) => {
    const skillsRoot = join(home, ".agents", "skills");
    snapshotSkills();
    writeDiskSkill(skillsRoot, "reload-retry-skill");

    const messages: Array<{ message: string; level: "info" | "warning" }> = [];
    const failed = await refreshCatalogForNewSkills({
      reload: async () => { throw new Error("reload failed"); },
      notify: (message, level) => messages.push({ message, level }),
    });

    assert.deepEqual(failed.map(skill => skill.name), ["reload-retry-skill"]);
    assert.deepEqual(detectNewSkills().map(skill => skill.name), ["reload-retry-skill"]);
    assert.equal(messages[0]?.level, "warning");

    const loaded = await refreshCatalogForNewSkills({
      reload: async () => {},
      notify: (message, level) => messages.push({ message, level }),
    });

    assert.deepEqual(loaded.map(skill => skill.name), ["reload-retry-skill"]);
    assert.deepEqual(detectNewSkills(), []);
    assert.ok(messages.some(({ level, message }) => level === "info" && message.includes("reload-retry-skill")));
  });
});

test("appendDiscoveredSkillsFallback exposes newly detected skills missing from the prompt", () => {
  const prompt = appendDiscoveredSkillsFallback("base system prompt", [{
    name: "fallback-skill",
    description: "Use when reload fails & skill is needed.",
    location: "/tmp/fallback-skill/SKILL.md",
  }]);

  assert.match(prompt, /<newly_discovered_skills>/);
  assert.match(prompt, /fallback-skill/);
  assert.match(prompt, /Use when reload fails &amp; skill is needed\./);
  assert.match(prompt, /\/tmp\/fallback-skill\/SKILL.md/);
});

test("appendDiscoveredSkillsFallback does not duplicate skills already in the prompt", () => {
  const prompt = "base system prompt\n/tmp/already-loaded/SKILL.md";

  assert.equal(appendDiscoveredSkillsFallback(prompt, [{
    name: "already-loaded",
    description: "Already present.",
    location: "/tmp/already-loaded/SKILL.md",
  }]), prompt);
});
