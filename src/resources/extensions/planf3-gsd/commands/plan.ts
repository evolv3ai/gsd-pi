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

export interface BuildChainFlags {
  auto: boolean;
  applyPrefs: boolean;
  force: boolean;
  allowUnsafeStep: boolean;
}

export type ChainSpec =
  | { target: "export" }
  | { target: "build"; flags: BuildChainFlags };

export interface PlanPromptOptions {
  skillPath: string;
  request: string;
  questionable: boolean;
  chain: ChainSpec;
}

/** The prompt injected into the host session (spec: six required elements).
 *  The agent Reads the SKILL.md itself — the prompt does not inline it. */
export function buildPlanPrompt(opts: PlanPromptOptions): string {
  const lines = [
    `Read the planf3 skill at ${opts.skillPath} and follow its workflow to produce a Planf3 HTML plan for the request below.`,
    ``,
    `USER_PROMPT: ${opts.request}`,
    `QUESTIONABLE: ${opts.questionable}`,
    ``,
    `Requirements:`,
    `- Write the plan HTML file into the specs/ directory, using the skill's own file-naming convention.`,
    `- QUESTIONABLE=true means: record assumptions in the plan's Q&A section instead of asking interactive questions. QUESTIONABLE=false means the skill's default behavior.`,
  ];
  if (opts.chain.target === "export") {
    lines.push(
      `- When the HTML file is written, call the planf3_gsd_export tool with htmlPath set to that file's path.`,
      `- When the tool returns, report back the plan HTML path and the spec/manifest paths from the tool result.`,
    );
  } else {
    const f = opts.chain.flags;
    lines.push(
      `- When the HTML file is written, call the planf3_gsd_build tool with htmlPath set to that file's path and auto=${f.auto}, applyPrefs=${f.applyPrefs}, force=${f.force}, allowUnsafeStep=${f.allowUnsafeStep}.`,
      `- When the tool returns, report back the plan HTML path, the milestone ID from the tool result, and the spec/manifest paths.`,
    );
  }
  return lines.join("\n");
}

export type PlanOutcome =
  | { ok: true; skillPath: string; prompt: string }
  | { ok: false; guidance: string };

export interface RunPlanOptions {
  cwd: string;
  homeDir?: string;
  request: string;
  questionable: boolean;
  chain: ChainSpec;
}

export async function runPlan(opts: RunPlanOptions): Promise<PlanOutcome> {
  const skillPath = await discoverPlanf3Skill({
    cwd: opts.cwd,
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  });
  if (skillPath === null) return { ok: false, guidance: SKILL_MISSING_GUIDANCE };
  return {
    ok: true,
    skillPath,
    prompt: buildPlanPrompt({
      skillPath,
      request: opts.request,
      questionable: opts.questionable,
      chain: opts.chain,
    }),
  };
}
