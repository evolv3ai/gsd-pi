import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { parseRequestArgs, registerPlanCommand, registerRunCommand } from "./plan-register.js";
import { SKILL_MISSING_GUIDANCE } from "./plan.js";

const RUN_FLAGS = ["--questionable", "--step", "--no-prefs", "--force", "--step-unsafe"];

describe("parseRequestArgs", () => {
  test("flags after the request", () => {
    const parsed = parseRequestArgs('"add dark mode" --questionable --force', RUN_FLAGS);
    assert.equal(parsed.request, '"add dark mode"');
    assert.deepEqual([...parsed.flags].sort(), ["--force", "--questionable"]);
  });

  test("flags before the request", () => {
    const parsed = parseRequestArgs("--step add dark mode", RUN_FLAGS);
    assert.equal(parsed.request, "add dark mode");
    assert.ok(parsed.flags.has("--step"));
  });

  test("flag in the middle leaves a single joining space", () => {
    const parsed = parseRequestArgs("fix login --force now", RUN_FLAGS);
    assert.equal(parsed.request, "fix login now");
    assert.ok(parsed.flags.has("--force"));
  });

  test("--step-unsafe does not also set --step", () => {
    const parsed = parseRequestArgs("fix it --step-unsafe", RUN_FLAGS);
    assert.ok(parsed.flags.has("--step-unsafe"));
    assert.ok(!parsed.flags.has("--step"));
    assert.equal(parsed.request, "fix it");
  });

  test("internal spacing of the request is preserved", () => {
    const parsed = parseRequestArgs("fix  the   bug --force", RUN_FLAGS);
    assert.equal(parsed.request, "fix  the   bug");
  });

  test("unrecognized --flags stay in the request", () => {
    const parsed = parseRequestArgs("support a --dry-run flag", RUN_FLAGS);
    assert.equal(parsed.request, "support a --dry-run flag");
    assert.equal(parsed.flags.size, 0);
  });

  test("empty and flags-only input → empty request", () => {
    assert.equal(parseRequestArgs("", RUN_FLAGS).request, "");
    assert.equal(parseRequestArgs("  --force  ", RUN_FLAGS).request, "");
  });
});

interface Emitted { message: string; type?: string }
interface Sent { content: string; options?: { deliverAs?: string } }

interface FakePi {
  pi: ExtensionAPI;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  sent: Sent[];
}

function makeFakePi(): FakePi {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const sent: Sent[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      sent.push({ content, ...(options !== undefined ? { options } : {}) });
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, sent };
}

// hasUI: true so emit() does not mirror to stdout during tests.
function makeCtx(): { ctx: unknown; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        emitted.push({ message, ...(type !== undefined ? { type } : {}) });
      },
    },
  };
  return { ctx, emitted };
}

async function makeSkillDir(root: string): Promise<string> {
  const dir = join(root, ".claude", "skills", "planf3");
  await mkdir(dir, { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  await writeFile(skillPath, "# planf3\n", "utf8");
  return skillPath;
}

describe("registerPlanCommand", () => {
  async function setup(withSkill: boolean) {
    const cwd = await mkdtemp(join(tmpdir(), "planf3-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "planf3-home-"));
    const skillPath = withSkill ? await makeSkillDir(cwd) : null;
    const fake = makeFakePi();
    registerPlanCommand(fake.pi, { cwd, homeDir: home });
    const handler = fake.commands.get("planf3-gsd-plan");
    assert.ok(handler, "command registered");
    return { ...fake, handler: handler!, skillPath };
  }

  test("empty request → usage error, no injection", async () => {
    const { handler, sent } = await setup(true);
    const { ctx, emitted } = makeCtx();
    await handler("", ctx);
    assert.equal(sent.length, 0);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.type, "error");
    assert.match(emitted[0]!.message, /^Usage: \/planf3-gsd-plan/);
  });

  test("missing skill → FR-1 guidance, sendUserMessage never called", async () => {
    const { handler, sent } = await setup(false);
    const { ctx, emitted } = makeCtx();
    await handler("do a thing", ctx);
    assert.equal(sent.length, 0);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.type, "error");
    assert.equal(emitted[0]!.message, SKILL_MISSING_GUIDANCE);
  });

  test("happy path → exactly one followUp injection chaining the export tool", async () => {
    const { handler, sent, skillPath } = await setup(true);
    const { ctx, emitted } = makeCtx();
    await handler("add dark mode", ctx);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.options, { deliverAs: "followUp" });
    assert.ok(sent[0]!.content.includes(skillPath!));
    assert.ok(sent[0]!.content.includes("USER_PROMPT: add dark mode"));
    assert.ok(sent[0]!.content.includes("QUESTIONABLE: false"));
    assert.ok(sent[0]!.content.includes("planf3_gsd_export"));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.type, "info");
    assert.ok(emitted[0]!.message.includes(skillPath!));
  });

  test("--questionable flips QUESTIONABLE, before or after the request", async () => {
    const { handler, sent } = await setup(true);
    const { ctx } = makeCtx();
    await handler("--questionable add dark mode", ctx);
    assert.ok(sent[0]!.content.includes("QUESTIONABLE: true"));
    assert.ok(sent[0]!.content.includes("USER_PROMPT: add dark mode"));
  });
});

describe("registerRunCommand", () => {
  async function setup(withSkill: boolean) {
    const cwd = await mkdtemp(join(tmpdir(), "planf3-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "planf3-home-"));
    const skillPath = withSkill ? await makeSkillDir(cwd) : null;
    const fake = makeFakePi();
    registerRunCommand(fake.pi, { cwd, homeDir: home });
    const handler = fake.commands.get("planf3-gsd-run");
    assert.ok(handler, "command registered");
    return { ...fake, handler: handler!, skillPath };
  }

  test("empty request → usage error, no injection", async () => {
    const { handler, sent } = await setup(true);
    const { ctx, emitted } = makeCtx();
    await handler("  --force  ", ctx);
    assert.equal(sent.length, 0);
    assert.equal(emitted[0]!.type, "error");
    assert.match(emitted[0]!.message, /^Usage: \/planf3-gsd-run/);
  });

  test("missing skill → FR-1 guidance, sendUserMessage never called", async () => {
    const { handler, sent } = await setup(false);
    const { ctx, emitted } = makeCtx();
    await handler("build me an app", ctx);
    assert.equal(sent.length, 0);
    assert.equal(emitted[0]!.message, SKILL_MISSING_GUIDANCE);
  });

  test("defaults: one followUp injection chaining the build tool with auto=true", async () => {
    const { handler, sent, skillPath } = await setup(true);
    const { ctx, emitted } = makeCtx();
    await handler("build me an app", ctx);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.options, { deliverAs: "followUp" });
    const prompt = sent[0]!.content;
    assert.ok(prompt.includes(skillPath!));
    assert.ok(prompt.includes("USER_PROMPT: build me an app"));
    assert.ok(prompt.includes("planf3_gsd_build"));
    assert.ok(!prompt.includes("planf3_gsd_export"));
    assert.ok(prompt.includes("auto=true"));
    assert.ok(prompt.includes("applyPrefs=true"));
    assert.ok(prompt.includes("force=false"));
    assert.ok(prompt.includes("allowUnsafeStep=false"));
    assert.equal(emitted[0]!.type, "info");
  });

  test("flag mapping: --step --no-prefs --force --step-unsafe --questionable", async () => {
    const { handler, sent } = await setup(true);
    const { ctx } = makeCtx();
    await handler("--step --no-prefs --force --step-unsafe --questionable rebuild the parser", ctx);
    const prompt = sent[0]!.content;
    assert.ok(prompt.includes("USER_PROMPT: rebuild the parser"));
    assert.ok(prompt.includes("QUESTIONABLE: true"));
    assert.ok(prompt.includes("auto=false"));
    assert.ok(prompt.includes("applyPrefs=false"));
    assert.ok(prompt.includes("force=true"));
    assert.ok(prompt.includes("allowUnsafeStep=true"));
  });

  test("--step alone maps to auto=false with allowUnsafeStep=false (gate fires downstream)", async () => {
    const { handler, sent } = await setup(true);
    const { ctx } = makeCtx();
    await handler("rebuild the parser --step", ctx);
    const prompt = sent[0]!.content;
    assert.ok(prompt.includes("auto=false"));
    assert.ok(prompt.includes("allowUnsafeStep=false"));
  });
});
