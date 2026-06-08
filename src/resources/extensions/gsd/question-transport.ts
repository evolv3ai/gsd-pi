// Project/App: gsd-pi
// File Purpose: Resolve how workflow units should ask the user for input.

export type StructuredQuestionsFlag = "true" | "false";

export interface QuestionTransportOptions {
  activeTools: string[];
  authMode?: "apiKey" | "oauth" | "externalCli" | "none";
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface QuestionTransportResolution {
  structuredQuestionsAvailable: StructuredQuestionsFlag;
  questionToolAvailable: boolean;
  usesWorkflowMcp: boolean;
  reason: "question-tool-available" | "question-tool-missing" | "workflow-mcp-disabled";
}

export interface WorkflowQuestionToolSurfaceOptions {
  workflowServerName?: string;
  workflowExplicitlyBlocked?: boolean;
  workflowMcpTools: string[];
  exactWorkflowMcpTools: string[];
  env?: NodeJS.ProcessEnv;
}

export interface WorkflowQuestionToolSurfaceResolution extends QuestionTransportResolution {
  questionToolName?: string;
  workflowQuestionsEnabled: boolean;
  disallowedTools: string[];
}

function mcpToolParts(toolName: string): { serverName: string; baseName: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const toolSeparator = toolName.indexOf("__", "mcp__".length);
  if (toolSeparator < 0) return null;
  return {
    serverName: toolName.slice("mcp__".length, toolSeparator),
    baseName: toolName.slice(toolSeparator + 2),
  };
}

function isWorkflowMcpServerName(serverName: string): boolean {
  const normalized = serverName.toLowerCase();
  return normalized === "gsd" || normalized.includes("workflow");
}

export function usesWorkflowMcpTransport(
  authMode: QuestionTransportOptions["authMode"],
  baseUrl: string | undefined,
): boolean {
  return authMode === "externalCli" && typeof baseUrl === "string" && baseUrl.startsWith("local://");
}

export function hasAskUserQuestionsTool(activeTools: string[]): boolean {
  return activeTools.some((toolName) => {
    if (toolName === "ask_user_questions") return true;
    const mcp = mcpToolParts(toolName);
    if (!mcp) return false;
    if (mcp.baseName === "ask_user_questions") return true;
    return mcp.baseName === "*" && isWorkflowMcpServerName(mcp.serverName);
  });
}

function workflowMcpStructuredQuestionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GSD_WORKFLOW_MCP_STRUCTURED_QUESTIONS?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

export function resolveQuestionTransport(
  options: QuestionTransportOptions,
): QuestionTransportResolution {
  const questionToolAvailable = hasAskUserQuestionsTool(options.activeTools);
  const usesWorkflowMcp = usesWorkflowMcpTransport(options.authMode, options.baseUrl);

  if (!questionToolAvailable) {
    return {
      structuredQuestionsAvailable: "false",
      questionToolAvailable,
      usesWorkflowMcp,
      reason: "question-tool-missing",
    };
  }

  if (usesWorkflowMcp && !workflowMcpStructuredQuestionsEnabled(options.env)) {
    return {
      structuredQuestionsAvailable: "false",
      questionToolAvailable,
      usesWorkflowMcp,
      reason: "workflow-mcp-disabled",
    };
  }

  return {
    structuredQuestionsAvailable: "true",
    questionToolAvailable,
    usesWorkflowMcp,
    reason: "question-tool-available",
  };
}

export function supportsStructuredQuestions(
  activeTools: string[],
  options: Omit<QuestionTransportOptions, "activeTools"> = {},
): boolean {
  return resolveQuestionTransport({
    ...options,
    activeTools,
  }).structuredQuestionsAvailable === "true";
}

export function resolveWorkflowQuestionToolSurface(
  options: WorkflowQuestionToolSurfaceOptions,
): WorkflowQuestionToolSurfaceResolution {
  const questionToolName = options.workflowServerName && !options.workflowExplicitlyBlocked
    ? `mcp__${options.workflowServerName}__ask_user_questions`
    : undefined;
  const activeTools = [
    ...options.exactWorkflowMcpTools,
    ...options.workflowMcpTools,
    ...(questionToolName ? [questionToolName] : []),
  ];
  const transport = resolveQuestionTransport({
    activeTools,
    authMode: "externalCli",
    baseUrl: "local://claude-code",
    env: options.env,
  });
  const exactQuestionToolAllowed =
    !!questionToolName && options.exactWorkflowMcpTools.includes(questionToolName);
  const workflowQuestionsEnabled =
    transport.structuredQuestionsAvailable === "true" &&
    (options.workflowMcpTools.length > 0 || exactQuestionToolAllowed);
  const disallowedTools =
    options.workflowServerName && transport.questionToolAvailable && !workflowQuestionsEnabled
      ? [`mcp__${options.workflowServerName}__ask_user_questions`]
      : [];

  return {
    ...transport,
    questionToolName,
    workflowQuestionsEnabled,
    disallowedTools,
  };
}
