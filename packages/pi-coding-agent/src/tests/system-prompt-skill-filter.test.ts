// @gsd/pi-coding-agent + system-prompt-skill-filter.test — coverage for the
// fact that skills are no longer embedded in the system prompt.
// Skills are discovered on-demand via the read tool (~29KB saved per request).
// The `skills` option is accepted but has no effect on prompt output.
// The `skillFilter` option was removed along with the <available_skills> block.

import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../core/system-prompt.js";
import type { Skill } from "../core/skills.js";

function makeSkill(name: string, description = `description for ${name}`): Skill {
	return {
		name,
		description,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		source: "project",
		disableModelInvocation: false,
	};
}

// ─── Skills are never rendered in the system prompt ──────────────────────────

test("buildSystemPrompt: skills option has no effect on output (skills not embedded)", () => {
	const skills = [makeSkill("alpha"), makeSkill("beta"), makeSkill("gamma")];
	const prompt = buildSystemPrompt({
		skills,
		selectedTools: ["read", "Skill"],
	});

	assert.ok(!prompt.includes("<available_skills>"), "no <available_skills> block");
	assert.ok(!prompt.includes("<name>alpha</name>"), "skill alpha not rendered");
	assert.ok(!prompt.includes("<name>beta</name>"), "skill beta not rendered");
	assert.ok(!prompt.includes("<name>gamma</name>"), "skill gamma not rendered");
	assert.ok(!prompt.includes("<skill>"), "no <skill> tags");
});

test("buildSystemPrompt: skills with disableModelInvocation also not rendered", () => {
	const skills: Skill[] = [
		{ ...makeSkill("visible"), disableModelInvocation: false },
		{ ...makeSkill("hidden"), disableModelInvocation: true },
	];
	const prompt = buildSystemPrompt({
		skills,
		selectedTools: ["read", "Skill"],
	});

	assert.ok(!prompt.includes("<available_skills>"), "no <available_skills> block");
	assert.ok(!prompt.includes("<name>visible</name>"), "visible skill not rendered");
	assert.ok(!prompt.includes("<name>hidden</name>"), "hidden skill not rendered");
});

test("buildSystemPrompt: empty skills array produces no skill references", () => {
	const prompt = buildSystemPrompt({
		skills: [],
		selectedTools: ["read", "Skill"],
	});

	assert.ok(!prompt.includes("<available_skills>"), "no <available_skills> block");
	assert.ok(!prompt.includes("<skill>"), "no <skill> tags");
});

// ─── Custom prompt branch ────────────────────────────────────────────────────

test("buildSystemPrompt (customPrompt): skills not rendered even with custom prompt", () => {
	const skills = [makeSkill("alpha"), makeSkill("beta")];
	const prompt = buildSystemPrompt({
		customPrompt: "CUSTOM BASE",
		skills,
		selectedTools: ["read", "Skill"],
	});

	assert.ok(!prompt.includes("<available_skills>"), "no <available_skills> block");
	assert.ok(!prompt.includes("<name>alpha</name>"), "skill alpha not rendered");
});

// ─── Pass-through of non-skill fields ────────────────────────────────────────

test("buildSystemPrompt: skills option does not affect context files or cwd rendering", () => {
	const skills = [makeSkill("alpha")];
	const prompt = buildSystemPrompt({
		skills,
		cwd: "/tmp/example",
		contextFiles: [{ path: "CLAUDE.md", content: "project instructions" }],
		selectedTools: ["read", "Skill"],
	});

	assert.ok(prompt.includes("/tmp/example"), "cwd should still render");
	assert.ok(prompt.includes("project instructions"), "context files should still render");
	assert.ok(!prompt.includes("<available_skills>"), "no skill catalog");
});

// ─── Tool list format ────────────────────────────────────────────────────────

test("buildSystemPrompt: tools are comma-separated, no per-tool descriptions", () => {
	const prompt = buildSystemPrompt({
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: {
			read: "Read file contents",
			bash: "Execute bash commands",
		},
	});

	assert.ok(prompt.includes("- read, bash, edit, write"), "comma-separated tool list");
	assert.ok(!prompt.includes("Read file contents"), "no per-tool descriptions");
});

test("buildSystemPrompt: empty tools list shows (none)", () => {
	const prompt = buildSystemPrompt({
		selectedTools: [],
	});

	assert.ok(prompt.includes("(none)"), "empty tools shows (none)");
});
