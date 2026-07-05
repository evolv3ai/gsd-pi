import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectAncestorAgentsSkillDirs,
	findGitRepoRoot,
	getSkillDirectories,
	type SkillDirKind,
} from "../src/core/skill-directories.ts";
import { CONFIG_DIR_NAME } from "../src/config.ts";

const GSD_HOME = join(homedir(), `.${CONFIG_DIR_NAME}`);

describe("findGitRepoRoot", () => {
	it("returns null when no .git exists up to filesystem root", () => {
		// /proc on Linux or a deeply nested non-existent path — either way, no .git.
		expect(findGitRepoRoot("/nonexistent/path/that/does/not/exist")).toBe(null);
	});
});

describe("collectAncestorAgentsSkillDirs", () => {
	it("includes <startDir>/.agents/skills as the first entry", () => {
		const dirs = collectAncestorAgentsSkillDirs("/tmp");
		expect(dirs[0]).toBe(join("/tmp", ".agents", "skills"));
	});

	it("walks ancestors while emitting one .agents/skills per level", () => {
		// Without a real .git anchor, the walk climbs to the filesystem root.
		const dirs = collectAncestorAgentsSkillDirs("/tmp");
		expect(dirs.length).toBeGreaterThan(1);
		// Every entry must end with .agents/skills
		for (const dir of dirs) {
			expect(dir.endsWith(join(".agents", "skills"))).toBe(true);
		}
	});
});

describe("getSkillDirectories", () => {
	it("returns one entry per kind plus ancestor expansion, in three-tier precedence order", () => {
		const cwd = "/tmp/myproject";
		const entries = getSkillDirectories({ cwd, gsdHome: GSD_HOME });

		// Three-tier precedence: project → bundled GSD → Claude/foreign.
		// Load order decides name-collision winners (first-loaded-wins).
		const kinds = entries.map((e) => e.kind);
		expect(kinds[0]).toBe("gsd-project");
		// Tier 1: project kinds (gsd-project, then agents-project ancestor walk).
		const firstAgentsProject = kinds.indexOf("agents-project");
		expect(firstAgentsProject).toBeGreaterThan(0);
		// Tier 2: bundled GSD (gsd-user) loads before any Claude kind.
		const gsdUserIdx = kinds.indexOf("gsd-user");
		expect(gsdUserIdx).toBeGreaterThan(firstAgentsProject);
		// Tier 3: Claude/foreign kinds (claude-project, agents-user, claude-user).
		const claudeProjectIdx = kinds.indexOf("claude-project");
		expect(claudeProjectIdx).toBeGreaterThan(gsdUserIdx);
		expect(kinds.indexOf("agents-user")).toBeGreaterThan(claudeProjectIdx);
		expect(kinds.indexOf("claude-user")).toBeGreaterThan(kinds.indexOf("agents-user"));
	});

	it("emits correct path, scope, and baseDir for the gsd-project kind", () => {
		const cwd = "/tmp/myproject";
		const entries = getSkillDirectories({ cwd, gsdHome: GSD_HOME });
		const gsdProject = entries.find((e) => e.kind === "gsd-project");
		expect(gsdProject).toBeDefined();
		expect(gsdProject!.path).toBe(join(cwd, CONFIG_DIR_NAME, "skills"));
		expect(gsdProject!.scope).toBe("project");
		expect(gsdProject!.baseDir).toBe(join(cwd, CONFIG_DIR_NAME));
	});

	it("emits correct path for the claude-project kind", () => {
		const cwd = "/tmp/myproject";
		const entries = getSkillDirectories({ cwd, gsdHome: GSD_HOME });
		const claudeProject = entries.find((e) => e.kind === "claude-project");
		expect(claudeProject).toBeDefined();
		expect(claudeProject!.path).toBe(join(cwd, ".claude", "skills"));
		expect(claudeProject!.scope).toBe("project");
		expect(claudeProject!.baseDir).toBe(join(cwd, ".claude"));
	});

	it("emits correct path for the gsd-user kind (~/.<configDir>/agent/skills)", () => {
		const entries = getSkillDirectories({ cwd: "/tmp/anywhere", gsdHome: GSD_HOME });
		const gsdUser = entries.find((e) => e.kind === "gsd-user");
		expect(gsdUser).toBeDefined();
		expect(gsdUser!.path).toBe(join(GSD_HOME, "agent", "skills"));
		expect(gsdUser!.scope).toBe("user");
		expect(gsdUser!.baseDir).toBe(join(GSD_HOME, "agent"));
	});

	it("emits correct path for the agents-user kind (~/.agents/skills)", () => {
		const entries = getSkillDirectories({ cwd: "/tmp/anywhere", gsdHome: GSD_HOME });
		const agentsUser = entries.find((e) => e.kind === "agents-user");
		expect(agentsUser).toBeDefined();
		expect(agentsUser!.path).toBe(join(homedir(), ".agents", "skills"));
		expect(agentsUser!.scope).toBe("user");
		expect(agentsUser!.baseDir).toBe(join(homedir(), ".agents"));
	});

	it("emits correct path for the claude-user kind (~/.claude/skills)", () => {
		const entries = getSkillDirectories({ cwd: "/tmp/anywhere", gsdHome: GSD_HOME });
		const claudeUser = entries.find((e) => e.kind === "claude-user");
		expect(claudeUser).toBeDefined();
		expect(claudeUser!.path).toBe(join(homedir(), ".claude", "skills"));
		expect(claudeUser!.scope).toBe("user");
		expect(claudeUser!.baseDir).toBe(join(homedir(), ".claude"));
	});

	it("expands agents-project into one entry per ancestor, nearest first", () => {
		// /tmp has no .git, so the walk climbs to root — at least two ancestors.
		const entries = getSkillDirectories({ cwd: "/tmp/myproject", gsdHome: GSD_HOME });
		const agentsProjectEntries = entries.filter((e) => e.kind === "agents-project");
		expect(agentsProjectEntries.length).toBeGreaterThanOrEqual(2);
		// Nearest first: /tmp/myproject/.agents/skills before /tmp/.agents/skills.
		expect(agentsProjectEntries[0].path).toBe(join("/tmp/myproject", ".agents", "skills"));
		expect(agentsProjectEntries[1].path).toBe(join("/tmp", ".agents", "skills"));
		// Each agents-project entry carries its own baseDir (the parent .agents dir).
		expect(agentsProjectEntries[0].baseDir).toBe(join("/tmp/myproject", ".agents"));
		expect(agentsProjectEntries[1].baseDir).toBe(join("/tmp", ".agents"));
	});

	it("every entry has a non-empty path, kind, scope, and baseDir", () => {
		const entries = getSkillDirectories({ cwd: "/tmp/anywhere", gsdHome: GSD_HOME });
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(typeof entry.path).toBe("string");
			expect(entry.path.length).toBeGreaterThan(0);
			expect(typeof entry.baseDir).toBe("string");
			expect(entry.baseDir.length).toBeGreaterThan(0);
			expect(entry.scope === "project" || entry.scope === "user").toBe(true);
		}
	});

	it("all six SkillDirKind values are represented when there is no git anchor", () => {
		const entries = getSkillDirectories({ cwd: "/tmp/anywhere", gsdHome: GSD_HOME });
		const kinds = new Set(entries.map((e) => e.kind));
		const allKinds: SkillDirKind[] = [
			"gsd-project",
			"agents-project",
			"claude-project",
			"gsd-user",
			"agents-user",
			"claude-user",
		];
		for (const k of allKinds) {
			expect(kinds.has(k), `expected kind ${k} to be present`).toBe(true);
		}
	});
});
