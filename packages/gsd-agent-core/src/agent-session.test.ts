import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillBlock } from "./agent-session.ts";
import { AgentSessionExtensionsModule } from "./session/agent-session-extensions.ts";

describe("parseSkillBlock", () => {
  test("parses a valid skill block with trailing user message", () => {
    const text = `<skill name="review" location=".gsd/skills/review.md">
Follow the checklist.
</skill>

Please review the patch.`;

    const parsed = parseSkillBlock(text);
    assert.ok(parsed);
    assert.equal(parsed.name, "review");
    assert.equal(parsed.location, ".gsd/skills/review.md");
    assert.match(parsed.content, /checklist/);
    assert.equal(parsed.userMessage, "Please review the patch.");
  });

  test("returns null for malformed skill blocks", () => {
    assert.equal(parseSkillBlock("not a skill"), null);
    assert.equal(parseSkillBlock('<skill name="x" location="y">missing close'), null);
  });
});

describe("AgentSessionExtensionsModule", () => {
  test("matches visible skills case-insensitively when rebuilding the prompt", () => {
    const host = {
      _cwd: "/tmp/project",
      _toolRegistry: new Map([["read", {}]]),
      _toolPromptSnippets: new Map(),
      _toolPromptGuidelines: new Map(),
      _visibleSkillNames: ["review-skill"],
      resourceLoader: {
        getSystemPrompt: () => undefined,
        getAppendSystemPrompt: () => [],
        getSkills: () => ({
          skills: [
            makeSkill("Review-Skill"),
            makeSkill("other-skill"),
          ],
        }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      },
    };

    const prompt = new AgentSessionExtensionsModule(host as any).rebuildSystemPrompt(["read"]);

    assert.match(prompt, /<name>Review-Skill<\/name>/);
    assert.doesNotMatch(prompt, /<name>other-skill<\/name>/);
  });
});

function makeSkill(name: string) {
  return {
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { kind: "test" },
    source: "test",
    disableModelInvocation: false,
  };
}
