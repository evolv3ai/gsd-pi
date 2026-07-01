import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillBlock } from "./agent-session.ts";
import { AgentSessionExtensionsModule } from "./session/agent-session-extensions.ts";
import { AgentSessionPromptModule } from "./session/agent-session-prompt.ts";

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
  test("bindExtensions forwards extension UI context into provider stream options", async () => {
    const uiContext = { notify: () => {} };
    let received: Record<string, unknown> | undefined;
    const host = {
      _extensionUIContext: undefined as typeof uiContext | undefined,
      _extensionRunner: {
        setUIContext: () => {},
        bindCommandContext: () => {},
        onError: () => () => {},
        emit: async () => {},
        hasHandlers: () => false,
      },
      _sessionStartEvent: { type: "session_start", reason: "startup" },
      agent: {
        streamFn: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
          received = options;
          return { type: "stream" } as any;
        },
      },
    };

    const mod = new AgentSessionExtensionsModule(host as any);
    await mod.bindExtensions({ uiContext: uiContext as any });

    host.agent.streamFn({}, {}, { maxTokens: 1 });
    assert.equal(received?.extensionUIContext, uiContext);
  });

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

describe("AgentSessionPromptModule", () => {
  test("keeps no-progress terminal fingerprint across other retryable errors", async () => {
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "do the work" }],
      timestamp: 1,
    };
    const events: Array<{ type: string }> = [];
    const host = {
      _retryAttempt: 0,
      _retryAbortController: undefined,
      settingsManager: {
        getRetrySettings: () => ({
          enabled: true,
          maxRetries: 5,
          baseDelayMs: 0,
        }),
      },
      emit: (event: { type: string }) => {
        events.push(event);
      },
      agent: {
        state: {
          messages: [] as any[],
        },
      },
    };
    const mod = new AgentSessionPromptModule(host as any);

    const firstTerminalFailure = makeAssistantError("terminated before any output");
    host.agent.state.messages = [userMessage, firstTerminalFailure];
    assert.equal(await mod.prepareRetry(firstTerminalFailure as any), true);

    const unrelatedRetryableFailure = makeAssistantError("overloaded_error: provider is busy");
    host.agent.state.messages = [userMessage, unrelatedRetryableFailure];
    assert.equal(await mod.prepareRetry(unrelatedRetryableFailure as any), true);

    const repeatedTerminalFailure = makeAssistantError("terminated before any output");
    host.agent.state.messages = [userMessage, repeatedTerminalFailure];
    assert.equal(mod.canPrepareRetry(repeatedTerminalFailure as any), false);
    assert.equal(await mod.prepareRetry(repeatedTerminalFailure as any), false);
    assert.equal(host._retryAttempt, 2);
    assert.equal(events.filter((event) => event.type === "auto_retry_start").length, 2);
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

function makeAssistantError(errorMessage: string) {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 1,
  };
}
