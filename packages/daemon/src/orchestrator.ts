/**
 * Orchestrator — Discord-facing controller for the #gsd-control channel.
 *
 * Receives Discord messages, filters them by channel/owner/bot guards, delegates
 * valid user content to OrchestratorAgent, and sends the response back to Discord.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { SessionManager } from './session-manager.js';
import type { ChannelManager } from './channel-manager.js';
import type { ProjectInfo } from './types.js';
import type { Logger } from './logger.js';
import { OrchestratorAgent } from './orchestrator-agent.js';

export interface OrchestratorConfig {
  model: string;
  max_tokens: number;
  control_channel_id: string;
}

export interface OrchestratorDeps {
  sessionManager: SessionManager;
  channelManager: ChannelManager;
  scanProjects: () => Promise<ProjectInfo[]>;
  config: OrchestratorConfig;
  logger: Logger;
  ownerId: string;
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly agent: OrchestratorAgent;

  constructor(deps: OrchestratorDeps, client?: Anthropic) {
    this.deps = deps;
    this.agent = new OrchestratorAgent(
      { model: deps.config.model, max_tokens: deps.config.max_tokens },
      {
        sessionManager: deps.sessionManager,
        scanProjects: deps.scanProjects,
        logger: deps.logger,
      },
      client,
    );
  }

  async handleMessage(message: DiscordMessageLike): Promise<void> {
    if (message.author.bot) return;
    if (message.channelId !== this.deps.config.control_channel_id) return;

    if (message.author.id !== this.deps.ownerId) {
      this.deps.logger.debug('orchestrator auth rejected', { userId: message.author.id });
      return;
    }

    const content = message.content?.trim();
    if (!content) return;

    this.deps.logger.info('orchestrator message received', {
      userId: message.author.id,
      channelId: message.channelId,
      contentLength: content.length,
    });

    try {
      await message.channel.sendTyping().catch(() => {});

      const responseText = await this.agent.run(content);
      await message.channel.send(responseText);

      this.deps.logger.info('orchestrator response sent', {
        channelId: message.channelId,
        responseLength: responseText.length,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.deps.logger.error('orchestrator error', {
        error: errorMsg,
        userId: message.author.id,
        channelId: message.channelId,
      });

      try {
        await message.channel.send('⚠️ Something went wrong processing your request.');
      } catch (sendErr) {
        this.deps.logger.warn('orchestrator error reply failed', {
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
    }
  }

  getHistory(): MessageParam[] {
    return this.agent.getHistory();
  }

  stop(): void {
    this.agent.stop();
  }
}

export interface DiscordMessageLike {
  author: { id: string; bot: boolean };
  channelId: string;
  content: string;
  channel: {
    send: (content: string) => Promise<unknown>;
    sendTyping: () => Promise<unknown>;
  };
}
