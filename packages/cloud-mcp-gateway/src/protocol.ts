export interface RuntimeProject {
  alias: string;
  path?: string;
  repoIdentity: string;
  remoteLabel?: string;
  markers?: string[];
}

export interface RuntimeHelloMessage {
  type: "hello";
  runtimeId: string;
  runtimeName?: string;
  projects: RuntimeProject[];
}

export interface RuntimeProjectsMessage {
  type: "projects";
  runtimeId?: string;
  projects: RuntimeProject[];
}

export interface RuntimeHeartbeatMessage {
  type: "heartbeat";
  runtimeId?: string;
  at?: number;
}

export interface RuntimeToolCallMessage {
  type: "tool_call";
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  projectAlias?: string;
}

export interface RuntimeToolResultMessage {
  type: "tool_result";
  requestId: string;
  result?: unknown;
  error?: string;
}

export interface RuntimeCancelMessage {
  type: "cancel";
  requestId: string;
}

export type GatewayToRuntimeMessage = RuntimeToolCallMessage | RuntimeCancelMessage;

export type RuntimeToGatewayMessage =
  | RuntimeHelloMessage
  | RuntimeProjectsMessage
  | RuntimeHeartbeatMessage
  | RuntimeToolResultMessage;

export interface CloudProjectRecord extends RuntimeProject {
  runtimeId: string;
  runtimeName?: string;
  online: boolean;
  lastSeenAt: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
