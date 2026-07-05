import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import {
  ORCHESTRATOR_TOOLS,
  executeOrchestratorTool,
  type OrchestratorToolContext,
} from './orchestrator-tools.js';

export interface OrchestratorAgentConfig {
  model: string;
  max_tokens: number;
}

const SYSTEM_PROMPT = `You are GSD Control — a concise, capable orchestrator for managing GSD (Git Ship Done) coding agent sessions via Discord.

You have tools to list projects, start sessions, get status, stop sessions, and inspect session details. Use them to fulfill the user's requests.

Response guidelines:
- Be terse and direct. No filler, no performed enthusiasm.
- When reporting status, use bullet points with project name, status, duration, and cost.
- When starting a session, confirm with the project name and session ID.
- When stopping a session, confirm which session was stopped.
- If something fails, say what went wrong plainly.
- Use Discord markdown formatting (bold, code blocks) for readability.
- Never expose internal error stack traces to the user — summarize the issue.`;

const MAX_HISTORY = 30;
const MAX_TOOL_ITERATIONS = 10;

function resolveAnthropicApiKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required. Set it in your environment or run `gsd config`.',
    );
  }
  return apiKey;
}

function isAuthError(message: string): boolean {
  return (
    message.includes('authentication') ||
    message.includes('apiKey') ||
    message.includes('authToken') ||
    message.includes('401')
  );
}

export class OrchestratorAgent {
  private readonly config: OrchestratorAgentConfig;
  private readonly toolContext: OrchestratorToolContext;
  private client: Anthropic | null;
  private history: MessageParam[] = [];

  constructor(
    config: OrchestratorAgentConfig,
    toolContext: OrchestratorToolContext,
    client?: Anthropic,
  ) {
    this.config = config;
    this.toolContext = toolContext;
    this.client = client ?? null;
  }

  async run(content: string): Promise<string> {
    this.history.push({ role: 'user', content });

    try {
      const responseText = await this.runToolLoop();
      this.history.push({ role: 'assistant', content: responseText });
      return responseText;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (isAuthError(errorMsg)) {
        this.client = null;
      }
      this.history.push({ role: 'assistant', content: '[error — see logs]' });
      throw err;
    } finally {
      this.trimHistory();
    }
  }

  getHistory(): MessageParam[] {
    return [...this.history];
  }

  stop(): void {
    this.history = [];
    this.client = null;
  }

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const apiKey = resolveAnthropicApiKey();
    const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
    this.client = new AnthropicSDK({ apiKey });
    return this.client;
  }

  private async runToolLoop(): Promise<string> {
    const client = await this.getClient();
    const { model, max_tokens } = this.config;

    let loopMessages: MessageParam[] = [...this.history];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await client.messages.create({
        model,
        max_tokens,
        system: SYSTEM_PROMPT,
        tools: ORCHESTRATOR_TOOLS,
        messages: loopMessages,
      });

      if (response.stop_reason !== 'tool_use') {
        const textBlocks = response.content.filter(
          (b): b is TextBlock => b.type === 'text',
        );
        return textBlocks.map((b) => b.text).join('\n') || '(No response)';
      }

      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );

      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executeOrchestratorTool(
          this.toolContext,
          toolUse.name,
          toolUse.input as Record<string, unknown>,
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      loopMessages = [
        ...loopMessages,
        { role: 'assistant', content: response.content as ContentBlockParam[] },
        { role: 'user', content: toolResults },
      ];
    }

    return 'I hit the maximum number of tool iterations. Please try a simpler request.';
  }

  private trimHistory(): void {
    while (this.history.length > MAX_HISTORY) {
      this.history.splice(0, 2);
    }
  }
}
