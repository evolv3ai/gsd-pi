import { z } from 'zod';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { SessionManager } from './session-manager.js';
import type { ProjectInfo, ManagedSession } from './types.js';
import type { Logger } from './logger.js';

export interface OrchestratorToolContext {
  sessionManager: SessionManager;
  scanProjects: () => Promise<ProjectInfo[]>;
  logger: Logger;
}

export const ORCHESTRATOR_TOOLS: Tool[] = [
  {
    name: 'list_projects',
    description: 'List all detected projects across configured scan roots. Returns project names, paths, and detected markers (git, node, gsd, etc.).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'start_session',
    description: 'Start a new GSD auto-mode session for a project. Provide the absolute project path. Optionally provide a command to run instead of the default "/gsd auto".',
    input_schema: {
      type: 'object' as const,
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project directory' },
        command: { type: 'string', description: 'Optional command to send instead of "/gsd auto"' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'get_status',
    description: 'Get the current status of all active GSD sessions. Shows project name, status, duration, and cost for each.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'stop_session',
    description: 'Stop a running GSD session. Provide a session ID or project name — fuzzy matching is used to find the session.',
    input_schema: {
      type: 'object' as const,
      properties: {
        identifier: { type: 'string', description: 'Session ID or project name to match' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'get_session_detail',
    description: 'Get detailed information about a specific session including cost breakdown, recent events, pending blockers, and error state.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'The session ID to inspect' },
      },
      required: ['sessionId'],
    },
  },
];

const StartSessionInput = z.object({
  projectPath: z.string(),
  command: z.string().optional(),
});

const StopSessionInput = z.object({
  identifier: z.string(),
});

const GetSessionDetailInput = z.object({
  sessionId: z.string(),
});

export async function executeOrchestratorTool(
  context: OrchestratorToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'list_projects':
        return await listProjects(context);
      case 'start_session':
        return await startSession(context, input);
      case 'get_status':
        return getStatus(context);
      case 'get_session_detail':
        return getSessionDetail(context, input);
      case 'stop_session':
        return await stopSession(context, input);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.logger.error('tool execution error', { tool: name, error: msg });
    return `Error: ${msg}`;
  }
}

async function listProjects(context: OrchestratorToolContext): Promise<string> {
  const projects = await context.scanProjects();
  if (projects.length === 0) return 'No projects found.';
  return JSON.stringify(
    projects.map((p) => ({ name: p.name, path: p.path, markers: p.markers })),
    null,
    2,
  );
}

async function startSession(
  context: OrchestratorToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const parsed = StartSessionInput.parse(input);
  const sessionId = await context.sessionManager.startSession({
    projectDir: parsed.projectPath,
    command: parsed.command,
  });
  return `Session started: ${sessionId} for ${parsed.projectPath}`;
}

function getStatus(context: OrchestratorToolContext): string {
  const sessions = context.sessionManager.getAllSessions();
  if (sessions.length === 0) return 'No active sessions.';

  return sessions
    .map((s: ManagedSession) => {
      const durationMin = Math.floor((Date.now() - s.startTime) / 60_000);
      const cost = s.cost.totalCost.toFixed(4);
      return `• ${s.projectName} — ${s.status} (${durationMin}m, $${cost})`;
    })
    .join('\n');
}

async function stopSession(
  context: OrchestratorToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const parsed = StopSessionInput.parse(input);
  const { identifier } = parsed;

  const byId = context.sessionManager.getSession(identifier);
  if (byId) {
    await context.sessionManager.cancelSession(identifier);
    return `Stopped session ${identifier} (${byId.projectName})`;
  }

  const normalizedIdentifier = identifier.toLowerCase();
  const match = context.sessionManager.getAllSessions().find(
    (s: ManagedSession) =>
      s.projectName.toLowerCase().includes(normalizedIdentifier) ||
      s.projectDir.toLowerCase().includes(normalizedIdentifier),
  );
  if (match) {
    await context.sessionManager.cancelSession(match.sessionId);
    return `Stopped session ${match.sessionId} (${match.projectName})`;
  }

  return `No session found matching "${identifier}"`;
}

function getSessionDetail(
  context: OrchestratorToolContext,
  input: Record<string, unknown>,
): string {
  const parsed = GetSessionDetailInput.parse(input);
  const result = context.sessionManager.getResult(parsed.sessionId);
  return JSON.stringify(result, null, 2);
}
