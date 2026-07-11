/**
 * Pure logic for /planf3-gsd-plan and /planf3-gsd-run: planf3 skill
 * discovery (PRD FR-1) and the injected-prompt builder (FR-2). No `pi`
 * dependency — the registration layer lives in plan-register.ts.
 */
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoverOptions {
  cwd: string;
  /** Injectable for tests — never touch the real home directory in a test. */
  homeDir?: string;
}

export const SKILL_MISSING_GUIDANCE = [
  "planf3 skill not found.",
  "Looked for: ./.claude/skills/planf3/SKILL.md, then ~/.claude/skills/planf3/SKILL.md.",
  "Install the planf3 skill (from the planf3 repo) into ./.claude/skills/planf3 or ~/.claude/skills/planf3, then re-run.",
].join("\n");

export async function discoverPlanf3Skill(opts: DiscoverOptions): Promise<string | null> {
  const home = opts.homeDir ?? homedir();
  const candidates = [
    join(opts.cwd, ".claude", "skills", "planf3", "SKILL.md"),
    join(home, ".claude", "skills", "planf3", "SKILL.md"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
