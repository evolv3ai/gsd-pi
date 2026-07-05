import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type, type TSchema } from "@sinclair/typebox";

import { BROWSER_CONTRACT_TOOL_NAMES, type BrowserContractToolName } from "../../shared/browser-contract.js";
import { resolveGsdBrowserMcpLaunchConfig, type GsdBrowserMcpLaunchConfig } from "../../shared/gsd-browser-cli.js";
import { buildMcpChildEnv } from "../../mcp-client/manager.js";

type ManagedBrowserToolResult = AgentToolResult<ManagedBrowserToolDetails> & { isError?: boolean };

interface ManagedBrowserToolDetails {
  engine: "gsd-browser";
  server: string;
  tool: string;
  mcpTool: string;
  /** All MCP tools invoked, in order, when a translation made multiple calls. */
  mcpTools?: string[];
  sessionName?: string;
  projectRoot?: string;
  truncated?: boolean;
  outputLines?: number;
  outputBytes?: number;
  structuredContent?: unknown;
  mcpIsError?: boolean;
  error?: string;
}

interface ManagedConnection {
  client: Client;
  transport: StdioClientTransport;
  launch: GsdBrowserMcpLaunchConfig;
}

type ConnectManagedGsdBrowser = (
  launch: GsdBrowserMcpLaunchConfig,
  signal?: AbortSignal,
) => Promise<ManagedConnection>;

type CloseManagedGsdBrowserConnection = (connection: ManagedConnection) => Promise<void>;

interface PendingManagedConnection {
  promise: Promise<ManagedConnection>;
  abortController: AbortController;
}

interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

interface ManagedTranslatedCall {
  mcpTool: string;
  args: Record<string, unknown>;
  /** Best-effort call: a failure adds no evidence but does not fail the tool. */
  optional?: boolean;
}

interface ManagedToolTranslation {
  /** Every MCP tool build() can emit; all must be served for contract coverage. */
  requires: readonly string[];
  /** Expand the Pi contract args into one or more sequential gsd-browser MCP calls. */
  build(args: Record<string, unknown>): ManagedTranslatedCall[];
}

interface ManagedBrowserToolSpec {
  /** gsd-browser MCP tool candidates, tried in order. Defaults to the contract name itself. */
  mcpTools?: string[];
  /**
   * Param-shape translation for contract tools gsd-browser does not serve
   * under any name. Takes precedence over mcpTools/name-based dispatch.
   */
  translate?: ManagedToolTranslation;
  label: string;
  description: string;
  parameters: TSchema;
  promptGuidelines?: string[];
  compatibility?: { producesImages?: boolean };
}

const DEFAULT_MAX_LINES = 2_000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const MCP_CALL_TIMEOUT_MS = 60_000;

const AssertionCheck = Type.Object({
  kind: Type.String({ description: "Assertion kind, e.g. url_contains, text_visible, selector_visible, no_console_errors, no_failed_requests." }),
  selector: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  checked: Type.Optional(Type.Boolean()),
  sinceActionId: Type.Optional(Type.Number()),
}, { additionalProperties: true });

const BatchStep = Type.Object({
  action: Type.String({ description: "Step action, e.g. navigate, click, type, wait_for, assert, click_ref, fill_ref." }),
  selector: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  condition: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  threshold: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
  clearFirst: Type.Optional(Type.Boolean()),
  submit: Type.Optional(Type.Boolean()),
  ref: Type.Optional(Type.String()),
  checks: Type.Optional(Type.Array(AssertionCheck)),
}, { additionalProperties: true });

/**
 * The managed adapter serves exactly the Browser Automation Contract
 * vocabulary. The spec table below is keyed by contract name, so adding a
 * contract capability fails typecheck here until the adapter declares how the
 * gsd-browser server satisfies it.
 */
export const MANAGED_GSD_BROWSER_TOOL_NAMES = BROWSER_CONTRACT_TOOL_NAMES;

export const MANAGED_BROWSER_TOOL_SPECS: Record<BrowserContractToolName, ManagedBrowserToolSpec> = {
  browser_navigate: {
    label: "Browser Navigate",
    description: "Navigate the managed gsd-browser session to a URL and return page state. Use for local web app verification and UAT evidence.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to, e.g. http://localhost:3000." }),
      screenshot: Type.Optional(Type.Boolean({ description: "Capture screenshot evidence when supported." })),
    }, { additionalProperties: true }),
  },
  browser_click: {
    translate: {
      requires: ["browser_batch"],
      build: (args) => [{
        mcpTool: "browser_batch",
        args: { steps: [{ action: "click", ...args }] },
      }],
    },
    label: "Browser Click",
    description: "Click an element in the managed gsd-browser session by selector or coordinates.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector to click." })),
      x: Type.Optional(Type.Number({ description: "X coordinate to click." })),
      y: Type.Optional(Type.Number({ description: "Y coordinate to click." })),
    }, { additionalProperties: true }),
  },
  browser_type: {
    translate: {
      requires: ["browser_batch"],
      build: (args) => [{
        mcpTool: "browser_batch",
        args: { steps: [{ action: "type", ...args }] },
      }],
    },
    label: "Browser Type",
    description: "Type or fill text into an input in the managed gsd-browser session.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector of the input to type into." })),
      text: Type.String({ description: "Text to enter." }),
      clearFirst: Type.Optional(Type.Boolean({ description: "Clear existing text first." })),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing." })),
      slowly: Type.Optional(Type.Boolean({ description: "Type character by character." })),
    }, { additionalProperties: true }),
  },
  browser_fill_form: {
    label: "Browser Fill Form",
    description: "Fill a form in the managed gsd-browser session using field labels, names, placeholders, or aria labels.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector targeting the form." })),
      values: Type.Record(Type.String(), Type.String(), { description: "Field identifier to value mapping." }),
      submit: Type.Optional(Type.Boolean({ description: "Submit the form after filling." })),
    }, { additionalProperties: true }),
  },
  browser_click_ref: {
    label: "Browser Click Ref",
    description: "Click a versioned ref from the latest gsd-browser snapshot.",
    parameters: Type.Object({
      ref: Type.String({ description: "Versioned ref, e.g. @v3:e2." }),
    }, { additionalProperties: true }),
  },
  browser_fill_ref: {
    label: "Browser Fill Ref",
    description: "Fill text into an input-like versioned ref from the latest gsd-browser snapshot.",
    parameters: Type.Object({
      ref: Type.String({ description: "Versioned ref, e.g. @v3:e1." }),
      text: Type.String({ description: "Text to enter." }),
      clearFirst: Type.Optional(Type.Boolean({ description: "Clear existing text first." })),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after filling." })),
      slowly: Type.Optional(Type.Boolean({ description: "Type character by character." })),
    }, { additionalProperties: true }),
  },
  browser_wait_for: {
    label: "Browser Wait For",
    description: "Wait for a browser condition such as network idle, selector visibility, text visibility, or URL change.",
    parameters: Type.Object({
      condition: Type.String({ description: "Condition, e.g. network_idle, selector_visible, text_visible, url_contains." }),
      value: Type.Optional(Type.String({ description: "Selector, text, URL substring, or delay value depending on condition." })),
      threshold: Type.Optional(Type.String({ description: "Threshold expression for count-based conditions." })),
      timeout: Type.Optional(Type.Number({ description: "Maximum milliseconds to wait." })),
    }, { additionalProperties: true }),
  },
  browser_assert: {
    label: "Browser Assert",
    description: "Run explicit browser assertions and return structured PASS/FAIL evidence.",
    promptGuidelines: [
      "Prefer browser_assert for final browser verification instead of inferring success from summaries.",
      "Use checks for URL, text, selector state, value, and browser diagnostics whenever those signals are available.",
    ],
    parameters: Type.Object({
      checks: Type.Array(AssertionCheck),
    }, { additionalProperties: true }),
  },
  browser_verify: {
    translate: {
      requires: ["browser_navigate", "browser_assert", "browser_screenshot"],
      build: (args) => {
        const calls: ManagedTranslatedCall[] = [
          {
            mcpTool: "browser_navigate",
            args: { url: args.url, ...(args.timeout === undefined ? {} : { timeout: args.timeout }) },
          },
        ];
        const verifyChecks = Array.isArray(args.checks) ? args.checks as Array<Record<string, unknown>> : [];
        const assertChecks: Array<Record<string, unknown>> = [];
        for (const check of verifyChecks) {
          if (typeof check.expectedText === "string") {
            assertChecks.push({ kind: "text_visible", text: check.expectedText });
          }
          if (typeof check.selector === "string") {
            if (check.expectedVisible === false) {
              assertChecks.push({ kind: "selector_hidden", selector: check.selector });
            } else if (check.expectedVisible === true || check.expectedText === undefined) {
              assertChecks.push({ kind: "selector_visible", selector: check.selector });
            }
          }
        }
        if (assertChecks.length > 0) {
          calls.push({ mcpTool: "browser_assert", args: { checks: assertChecks } });
        }
        if (verifyChecks.some((check) => check.screenshot === true)) {
          calls.push({ mcpTool: "browser_screenshot", args: {}, optional: true });
        }
        return calls;
      },
    },
    label: "Browser Verify",
    description: "Run a structured browser verification flow and return evidence from the managed gsd-browser session.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to verify." }),
      checks: Type.Array(Type.Object({
        description: Type.String({ description: "What this check verifies." }),
        selector: Type.Optional(Type.String()),
        expectedText: Type.Optional(Type.String()),
        expectedVisible: Type.Optional(Type.Boolean()),
        screenshot: Type.Optional(Type.Boolean()),
      }, { additionalProperties: true })),
      timeout: Type.Optional(Type.Number({ description: "Navigation timeout in milliseconds." })),
    }, { additionalProperties: true }),
  },
  browser_screenshot: {
    label: "Browser Screenshot",
    description: "Capture browser screenshot evidence from the managed gsd-browser session.",
    compatibility: { producesImages: true },
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page." })),
      selector: Type.Optional(Type.String({ description: "CSS selector to crop." })),
      quality: Type.Optional(Type.Number({ description: "JPEG quality when supported." })),
    }, { additionalProperties: true }),
  },
  browser_snapshot_refs: {
    mcpTools: ["browser_snapshot", "browser_snapshot_refs"],
    label: "Browser Snapshot Refs",
    description: "Capture a compact gsd-browser snapshot with versioned refs for reliable interaction.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "Optional CSS selector scope." })),
      interactiveOnly: Type.Optional(Type.Boolean({ description: "Compatibility flag; use mode for gsd-browser filtering." })),
      limit: Type.Optional(Type.Number({ description: "Maximum elements to include." })),
      mode: Type.Optional(Type.String({ description: "Snapshot mode: interactive, form, dialog, navigation, errors, headings, visible_only." })),
    }, { additionalProperties: true }),
  },
  browser_find: {
    mcpTools: ["browser_find_element", "browser_find"],
    label: "Browser Find",
    description: "Find elements by text, role, or selector in the managed gsd-browser session.",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "Visible text to find." })),
      role: Type.Optional(Type.String({ description: "ARIA role to filter by." })),
      selector: Type.Optional(Type.String({ description: "CSS selector to scope or match." })),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return." })),
    }, { additionalProperties: true }),
  },
  browser_get_console_logs: {
    mcpTools: ["browser_console", "browser_get_console_logs"],
    label: "Browser Console Logs",
    description: "Return buffered console logs and JavaScript errors from the managed gsd-browser session.",
    parameters: Type.Object({
      clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading logs." })),
    }, { additionalProperties: true }),
  },
  browser_get_network_logs: {
    mcpTools: ["browser_network", "browser_get_network_logs"],
    label: "Browser Network Logs",
    description: "Return buffered network requests and responses from the managed gsd-browser session.",
    parameters: Type.Object({
      clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading logs." })),
      filter: Type.Optional(Type.String({ description: "Filter, e.g. all, errors, fetch-xhr." })),
    }, { additionalProperties: true }),
  },
  browser_evaluate: {
    mcpTools: ["browser_eval", "browser_evaluate"],
    label: "Browser Evaluate",
    description: "Evaluate a JavaScript expression in the managed gsd-browser page context.",
    parameters: Type.Object({
      expression: Type.String({ description: "JavaScript expression to evaluate." }),
    }, { additionalProperties: true }),
  },
  browser_reload: {
    // gsd-browser's daemon has a reload command but does not expose it over
    // MCP, so reload rides browser_evaluate. The network-idle settle is
    // best-effort: pages with persistent connections never go idle.
    translate: {
      requires: ["browser_evaluate", "browser_wait_for"],
      build: () => [
        { mcpTool: "browser_evaluate", args: { expression: "location.reload()" } },
        { mcpTool: "browser_wait_for", args: { condition: "network_idle", timeout: 3_000 }, optional: true },
      ],
    },
    label: "Browser Reload",
    description: "Reload the current page in the managed gsd-browser session.",
    parameters: Type.Object({}, { additionalProperties: true }),
  },
  browser_batch: {
    label: "Browser Batch",
    description: "Execute multiple explicit browser steps through the managed gsd-browser session in one call.",
    promptGuidelines: [
      "Use browser_batch for obvious low-risk sequences like navigate, snapshot, click, type, wait, assert.",
      "Keep browser_batch steps explicit; do not use it as a speculative planner.",
    ],
    parameters: Type.Object({
      steps: Type.Array(BatchStep),
      stopOnFailure: Type.Optional(Type.Boolean({ description: "Stop after the first failing step." })),
      finalSummaryOnly: Type.Optional(Type.Boolean({ description: "Return only the compact final summary." })),
    }, { additionalProperties: true }),
  },
  browser_act: {
    label: "Browser Act",
    description: "Execute a semantic browser action through gsd-browser, such as primary_cta, submit_form, or close_dialog.",
    parameters: Type.Object({
      intent: Type.String({ description: "Semantic intent, e.g. submit_form, close_dialog, primary_cta, search_field, accept_cookies." }),
      scope: Type.Optional(Type.String({ description: "CSS selector to narrow the search area." })),
    }, { additionalProperties: true }),
  },
};

function resolveProjectRoot(ctx?: ExtensionContext): string {
  return ctx?.cwd || process.cwd();
}

function resolveManagedSessionSuffix(ctx?: ExtensionContext): string {
  const explicit = process.env.GSD_BROWSER_SESSION_SUFFIX?.trim() || process.env.GSD_BROWSER_SESSION_ID?.trim();
  if (explicit) return explicit;

  try {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (sessionId) return `pi-${sessionId.slice(0, 12)}`;
  } catch {
    // Fall back to pid below when session metadata is unavailable.
  }

  return `pi-${process.pid}`;
}

function buildConnectionKey(launch: GsdBrowserMcpLaunchConfig): string {
  return JSON.stringify({
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env ?? {},
  });
}

function combineAbortSignals(
  poolSignal: AbortSignal,
  callerSignal?: AbortSignal,
): AbortSignal {
  if (!callerSignal) return poolSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([poolSignal, callerSignal]);
  }

  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (poolSignal.aborted || callerSignal.aborted) {
    abort();
  } else {
    poolSignal.addEventListener("abort", abort, { once: true });
    callerSignal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

export class ManagedGsdBrowserConnectionPool {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly pendingConnections = new Map<string, PendingManagedConnection>();
  private readonly connect: ConnectManagedGsdBrowser;
  private readonly closeConnection: CloseManagedGsdBrowserConnection;
  private generation = 0;
  private closing = false;

  constructor(
    connect: ConnectManagedGsdBrowser,
    closeConnection: CloseManagedGsdBrowserConnection,
  ) {
    this.connect = connect;
    this.closeConnection = closeConnection;
  }

  get activeCount(): number {
    return this.connections.size;
  }

  get pendingCount(): number {
    return this.pendingConnections.size;
  }

  getOrConnect(
    launch: GsdBrowserMcpLaunchConfig,
    signal?: AbortSignal,
  ): Promise<ManagedConnection> {
    if (this.closing) {
      return Promise.reject(new Error("gsd-browser connection pool is closing"));
    }

    const key = buildConnectionKey(launch);
    const existing = this.connections.get(key);
    if (existing) return Promise.resolve(existing);

    const pending = this.pendingConnections.get(key);
    if (pending) return pending.promise;

    const generation = this.generation;
    const abortController = new AbortController();
    const connectionSignal = combineAbortSignals(abortController.signal, signal);
    const connectionPromise = this.connect(launch, connectionSignal)
      .then(async (connection) => {
        if (this.closing || this.generation !== generation) {
          await this.closeConnection(connection);
          throw new Error("gsd-browser connection closed during startup");
        }
        this.connections.set(key, connection);
        return connection;
      })
      .finally(() => {
        if (this.pendingConnections.get(key)?.promise === connectionPromise) {
          this.pendingConnections.delete(key);
        }
      });

    this.pendingConnections.set(key, { promise: connectionPromise, abortController });
    return connectionPromise;
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    this.generation += 1;

    const activeConnections = Array.from(this.connections.values());
    const pendingConnections = Array.from(this.pendingConnections.values());
    this.connections.clear();
    this.pendingConnections.clear();
    for (const pending of pendingConnections) {
      pending.abortController.abort();
    }

    const closingActive = activeConnections.map((connection) => this.closeConnection(connection));
    const closingPending = pendingConnections.map(async (pending) => {
      try {
        const connection = await pending.promise;
        await this.closeConnection(connection);
      } catch {
        // Failed or invalidated connection attempts have already cleaned up.
      }
    });

    try {
      await Promise.allSettled([...closingActive, ...closingPending]);
    } finally {
      this.closing = false;
      this.generation += 1;
    }
  }
}

async function connectManagedGsdBrowser(
  launch: GsdBrowserMcpLaunchConfig,
  signal?: AbortSignal,
): Promise<ManagedConnection> {
  const client = new Client({ name: "gsd-pi-browser-tools", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: buildMcpChildEnv(launch.env),
    cwd: launch.cwd,
    stderr: "pipe",
  });

  try {
    await client.connect(transport, { signal, timeout: 30000 });
    return { client, transport, launch };
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // Best-effort cleanup after a failed or aborted connection attempt.
    }
    try {
      await client.close();
    } catch {
      // Best-effort cleanup after a failed or aborted connection attempt.
    }
    throw error;
  }
}

async function closeManagedGsdBrowserConnection(connection: ManagedConnection): Promise<void> {
  try {
    await connection.client.close();
  } catch {
    // Best-effort cleanup.
  }
  try {
    await connection.transport.close();
  } catch {
    // Best-effort cleanup.
  }
}

const connectionPool = new ManagedGsdBrowserConnectionPool(
  connectManagedGsdBrowser,
  closeManagedGsdBrowserConnection,
);

async function getOrConnectManagedGsdBrowser(
  ctx?: ExtensionContext,
  signal?: AbortSignal,
): Promise<ManagedConnection> {
  const launch = resolveGsdBrowserMcpLaunchConfig(resolveProjectRoot(ctx), process.env, {
    sessionSuffix: resolveManagedSessionSuffix(ctx),
  });
  return connectionPool.getOrConnect(launch, signal);
}

function isUnknownMcpToolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown tool|tool .*not found|tool not found|not registered|does not exist/i.test(message);
}

function normalizeBatchStep(step: unknown): unknown {
  if (!step || typeof step !== "object") return step;
  const { clearFirst, ...rest } = step as Record<string, unknown>;
  return clearFirst === undefined ? step : { ...rest, clear_first: clearFirst };
}

export function normalizeManagedArgs(piToolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (piToolName === "browser_snapshot_refs") {
    const { interactiveOnly: _interactiveOnly, ...snapshotArgs } = args;
    return snapshotArgs;
  }
  if (piToolName === "browser_batch") {
    // gsd-browser's MCP batch tool reads snake_case option and step keys.
    const { stopOnFailure, finalSummaryOnly, steps, ...rest } = args;
    return {
      ...rest,
      ...(Array.isArray(steps) ? { steps: steps.map(normalizeBatchStep) } : {}),
      ...(stopOnFailure === undefined ? {} : { stop_on_failure: stopOnFailure }),
      ...(finalSummaryOnly === undefined ? {} : { summary_only: finalSummaryOnly }),
    };
  }
  return args;
}

function serializeMcpContent(
  contentItems: McpContentItem[],
): { content: ManagedBrowserToolResult["content"]; truncated: boolean; outputLines: number; outputBytes: number } {
  const imageItems: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const textParts: string[] = [];

  for (const item of contentItems) {
    if (item.type === "text") {
      textParts.push(item.text ?? "");
      continue;
    }
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      imageItems.push({ type: "image", data: item.data, mimeType: item.mimeType });
      textParts.push(`[image evidence: ${item.mimeType}]`);
      continue;
    }
    textParts.push(JSON.stringify(item));
  }

  const rawText = textParts.filter((part) => part.length > 0).join("\n");
  const truncation = truncateHeadText(rawText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let finalText = truncation.content;
  if (truncation.truncated) {
    finalText += `\n\n[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatByteSize(truncation.outputBytes)} of ${formatByteSize(truncation.totalBytes)})]`;
  }

  let content: ManagedBrowserToolResult["content"];
  if (finalText) {
    content = [{ type: "text", text: finalText }, ...imageItems];
  } else if (imageItems.length > 0) {
    content = imageItems;
  } else {
    content = [{ type: "text", text: "gsd-browser returned no content." }];
  }

  return {
    content,
    truncated: truncation.truncated,
    outputLines: truncation.outputLines,
    outputBytes: truncation.outputBytes,
  };
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateHeadText(
  text: string,
  options: { maxLines: number; maxBytes: number },
): { content: string; truncated: boolean; outputLines: number; totalLines: number; outputBytes: number; totalBytes: number } {
  const totalBytes = Buffer.byteLength(text, "utf-8");
  const allLines = text.split(/\r?\n/);
  const totalLines = text.length === 0 ? 0 : allLines.length;
  let content = allLines.slice(0, options.maxLines).join("\n");

  while (Buffer.byteLength(content, "utf-8") > options.maxBytes && content.length > 0) {
    content = content.slice(0, Math.max(0, content.length - 1024));
  }

  const outputBytes = Buffer.byteLength(content, "utf-8");
  const outputLines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  return {
    content,
    truncated: outputLines < totalLines || outputBytes < totalBytes,
    outputLines,
    totalLines,
    outputBytes,
    totalBytes,
  };
}

type McpToolCallResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

function callGsdBrowserMcp(
  connection: ManagedConnection,
  mcpTool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpToolCallResult> {
  return connection.client.callTool(
    { name: mcpTool, arguments: args },
    undefined,
    { signal, timeout: MCP_CALL_TIMEOUT_MS },
  ) as Promise<McpToolCallResult>;
}

function buildManagedToolResult(
  connection: ManagedConnection,
  piToolName: string,
  mcpToolsUsed: string[],
  contentItems: McpContentItem[],
  lastResult: McpToolCallResult,
): ManagedBrowserToolResult {
  const serialized = serializeMcpContent(contentItems);
  return {
    content: serialized.content,
    details: {
      engine: "gsd-browser",
      server: connection.launch.serverName,
      tool: piToolName,
      mcpTool: mcpToolsUsed[mcpToolsUsed.length - 1] ?? piToolName,
      ...(mcpToolsUsed.length > 1 ? { mcpTools: mcpToolsUsed } : {}),
      sessionName: connection.launch.sessionName,
      projectRoot: connection.launch.projectRoot,
      truncated: serialized.truncated,
      outputLines: serialized.outputLines,
      outputBytes: serialized.outputBytes,
      structuredContent: lastResult.structuredContent,
      mcpIsError: Boolean(lastResult.isError),
    },
    isError: Boolean(lastResult.isError),
  };
}

async function callTranslatedGsdBrowserTool(
  connection: ManagedConnection,
  piToolName: string,
  translation: ManagedToolTranslation,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal },
): Promise<ManagedBrowserToolResult> {
  const calls = translation.build(args);
  const contentItems: McpContentItem[] = [];
  const toolsUsed: string[] = [];
  let lastResult: McpToolCallResult = {};

  for (const call of calls) {
    let result: McpToolCallResult;
    try {
      result = await callGsdBrowserMcp(connection, call.mcpTool, normalizeManagedArgs(call.mcpTool, call.args), options.signal);
    } catch (error) {
      if (call.optional) continue;
      throw error;
    }
    if (call.optional && result.isError) continue;
    toolsUsed.push(call.mcpTool);
    if (Array.isArray(result.content)) contentItems.push(...result.content as McpContentItem[]);
    lastResult = result;
    // Later calls assume the earlier ones took effect (e.g. assert after a
    // failed navigation would report misleading evidence), so stop here.
    if (lastResult.isError) break;
  }

  return buildManagedToolResult(connection, piToolName, toolsUsed, contentItems, lastResult);
}

async function callManagedGsdBrowserTool(
  piToolName: string,
  spec: ManagedBrowserToolSpec,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; ctx?: ExtensionContext },
): Promise<ManagedBrowserToolResult> {
  const connection = await getOrConnectManagedGsdBrowser(options.ctx, options.signal);
  const normalizedArgs = normalizeManagedArgs(piToolName, args);

  if (spec.translate) {
    return callTranslatedGsdBrowserTool(connection, piToolName, spec.translate, normalizedArgs, options);
  }

  let lastError: unknown;
  for (const mcpTool of spec.mcpTools ?? [piToolName]) {
    try {
      const result = await callGsdBrowserMcp(connection, mcpTool, normalizedArgs, options.signal);
      const contentItems = Array.isArray(result.content) ? result.content as McpContentItem[] : [];
      return buildManagedToolResult(connection, piToolName, [mcpTool], contentItems, result);
    } catch (error) {
      lastError = error;
      if (!isUnknownMcpToolError(error)) break;
    }
  }

  throw lastError;
}

function formatManagedBrowserError(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    `gsd-browser engine or tool unavailable for ${toolName}: ${message}`,
    "",
    "The managed gsd-browser engine is enabled for this session but is unavailable.",
    "Run /gsd doctor or reinstall dependencies so @opengsd/gsd-browser is available.",
    "Unset GSD_BROWSER_ENGINE or set GSD_BROWSER_ENGINE=playwright to use the default Playwright engine.",
  ].join("\n");
}

/**
 * Contract tools the server's advertised tool list cannot satisfy through any
 * of their declared MCP candidates or translations.
 */
export function findMissingContractCoverage(servedToolNames: Iterable<string>): BrowserContractToolName[] {
  const served = new Set(servedToolNames);
  return BROWSER_CONTRACT_TOOL_NAMES.filter((name) => {
    const spec = MANAGED_BROWSER_TOOL_SPECS[name];
    if (spec.translate) {
      return !spec.translate.requires.every((required) => served.has(required));
    }
    const candidates = spec.mcpTools ?? [name];
    return !candidates.some((candidate) => served.has(candidate));
  });
}

/**
 * Compare the server's advertised tool list against the Browser Automation
 * Contract so a server that stops serving a contract tool surfaces at warm-up
 * instead of as a first-use error. Best-effort: a failed or empty listing
 * returns no warning (call-time alias fallback still applies).
 */
async function verifyContractCoverage(
  connection: ManagedConnection,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let served: string[];
  try {
    const result = await connection.client.listTools(undefined, { signal, timeout: 10000 });
    served = (result.tools ?? []).map((tool) => tool.name);
  } catch {
    return undefined;
  }
  if (served.length === 0) return undefined;

  const missing = findMissingContractCoverage(served);
  if (missing.length === 0) return undefined;
  return `gsd-browser does not serve ${missing.length} Browser Automation Contract tool(s): ${missing.join(", ")}. These will error on first use; update gsd-browser or check GSD_BROWSER_* overrides.`;
}

/**
 * Eagerly establish the managed gsd-browser connection so browser tools are
 * ready before first use. Best-effort: returns the error instead of throwing so
 * callers (e.g. session-start warm-up) can surface a warning without failing the
 * session. Connecting only spawns the gsd-browser MCP daemon; it does not launch
 * Chrome (that happens lazily on the first navigation).
 */
export async function warmUpManagedGsdBrowser(
  ctx?: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ ok: true; coverageWarning?: string } | { ok: false; error: string }> {
  try {
    const connection = await getOrConnectManagedGsdBrowser(ctx, signal);
    const coverageWarning = await verifyContractCoverage(connection, signal);
    return coverageWarning ? { ok: true, coverageWarning } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerManagedGsdBrowserTools(pi: ExtensionAPI): void {
  for (const name of BROWSER_CONTRACT_TOOL_NAMES) {
    const tool = MANAGED_BROWSER_TOOL_SPECS[name];
    pi.registerTool({
      name,
      label: tool.label,
      description: tool.description,
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      ...(tool.compatibility ? { compatibility: tool.compatibility } : {}),
      parameters: tool.parameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        try {
          return await callManagedGsdBrowserTool(
            name,
            tool,
            params as Record<string, unknown>,
            { signal, ctx },
          );
        } catch (error) {
          const message = formatManagedBrowserError(name, error);
          return {
            content: [{ type: "text", text: message }],
            details: {
              engine: "gsd-browser",
              server: "gsd-browser",
              tool: name,
              mcpTool: tool.translate?.requires[0] ?? tool.mcpTools?.[0] ?? name,
              error: error instanceof Error ? error.message : String(error),
            },
            isError: true,
          };
        }
      },
    });
  }
}

export async function closeManagedGsdBrowser(): Promise<void> {
  await connectionPool.closeAll();
}

export async function _resetManagedGsdBrowserForTest(): Promise<void> {
  await closeManagedGsdBrowser();
}
