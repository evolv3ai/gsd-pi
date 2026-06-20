import { spawn } from "node:child_process";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
} from "@gsd/pi-ai";
import { createAssistantMessageEventStream } from "@gsd/pi-ai";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type GoogleCliProviderId = "google-gemini-cli" | "google-antigravity";

interface CliRunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
}

function textBlocks(content: (TextContent | { type: string })[]): string {
	return content
		.map((block) => block.type === "text" ? (block as TextContent).text : `[${block.type} omitted]`)
		.join("\n");
}

function messageToText(message: Message): string {
	if (message.role === "user") {
		const content = typeof message.content === "string" ? message.content : textBlocks(message.content);
		return `User:\n${content}`;
	}

	if (message.role === "assistant") {
		const text = message.content
			.map((block) => {
				if (block.type === "text") return block.text;
				if (block.type === "thinking") return `[thinking omitted]`;
				if (block.type === "toolCall") return `[tool call: ${block.name}]`;
				if (block.type === "serverToolUse") return `[server tool: ${block.name}]`;
				if (block.type === "webSearchResult") return `[web search result omitted]`;
				return `[${(block as { type: string }).type} omitted]`;
			})
			.join("\n");
		return `Assistant:\n${text}`;
	}

	return `Tool result (${message.toolName}):\n${textBlocks(message.content)}`;
}

export function buildGoogleCliPrompt(context: Context): string {
	const parts: string[] = [];

	if (context.systemPrompt?.trim()) {
		parts.push(`System instructions:\n${context.systemPrompt.trim()}`);
	}

	if (context.messages.length > 0) {
		parts.push(context.messages.map(messageToText).join("\n\n"));
	}

	if (context.tools?.length) {
		const names = context.tools.map((tool) => tool.name).join(", ");
		parts.push(
			`Available local GSD tools were not forwarded to this external CLI bridge. ` +
			`If you need to act, use the CLI's own tools or ask the user to switch to a provider with native tool-call support. ` +
			`Requested GSD tools: ${names}`,
		);
	}

	return parts.join("\n\n").trim();
}

function buildAssistantMessage(
	model: Model<Api>,
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function extractGeminiJsonResponse(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";

	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		for (const key of ["response", "text", "content", "message"]) {
			const value = parsed[key];
			if (typeof value === "string") return value;
		}
		return JSON.stringify(parsed, null, 2);
	} catch {
		return trimmed;
	}
}

function commandForProvider(provider: GoogleCliProviderId): string {
	return provider === "google-gemini-cli" ? "gemini" : "agy";
}

function argsForProvider(provider: GoogleCliProviderId, model: Model<Api>, prompt: string): string[] {
	if (provider === "google-gemini-cli") {
		const args = ["-p", prompt, "--output-format", "json"];
		if (model.id !== "default") args.unshift("-m", model.id);
		return args;
	}

	const args = ["-p", prompt];
	if (model.id !== "default") args.unshift("-m", model.id);
	return args;
}

export function buildGoogleCliSpawnInvocation(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	if (platform === "win32") {
		return { command: "cmd", args: ["/c", command, ...args] };
	}
	return { command, args };
}

function runCli(command: string, args: string[], options?: SimpleStreamOptions): Promise<CliRunResult> {
	return new Promise((resolve, reject) => {
		const invocation = buildGoogleCliSpawnInvocation(command, args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: options?.cwd || process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			options?.signal?.removeEventListener("abort", onAbort);
			fn();
		};

		const onAbort = () => {
			child.kill("SIGTERM");
			settle(() => reject(new Error("Request was aborted")));
		};

		if (options?.signal?.aborted) {
			onAbort();
			return;
		}
		options?.signal?.addEventListener("abort", onAbort);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		child.on("error", (error) => {
			settle(() => reject(error));
		});

		child.on("close", (code, signal) => {
			settle(() => resolve({ stdout, stderr, code, signal }));
		});
	});
}

function emitText(stream: AssistantMessageEventStream, message: AssistantMessage, text: string): void {
	stream.push({ type: "start", partial: { ...message, content: [] } });
	if (text) {
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
	}
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
}

function isGeminiCliDeprecatedCliOutput(text: string): boolean {
	return (
		/IneligibleTierError/i.test(text)
		|| /UNSUPPORTED_CLIENT/i.test(text)
		|| /no longer supported for Gemini Code Assist for individuals/i.test(text)
		|| /migrate to the Antigravity suite/i.test(text)
	);
}

const GEMINI_CLI_DEPRECATION_HINT =
	"Gemini CLI is no longer supported for individual users. Install Antigravity CLI " +
	"(curl -fsSL https://antigravity.google/cli/install.sh | bash), run `agy` to authenticate, " +
	"then use /login → Antigravity or restart GSD to auto-migrate.";

function formatGoogleCliError(detail: string, provider: GoogleCliProviderId): string {
	if (provider === "google-gemini-cli" && isGeminiCliDeprecatedCliOutput(detail)) {
		return `${detail}\n\n${GEMINI_CLI_DEPRECATION_HINT}`;
	}
	return detail;
}

function emitError(stream: AssistantMessageEventStream, model: Model<Api>, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const output = buildAssistantMessage(model, "", "error", message);
	stream.push({ type: "error", reason: "error", error: output });
	stream.end(output);
}

export function streamViaGoogleCli(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const provider = model.provider as GoogleCliProviderId;

	queueMicrotask(async () => {
		try {
			const prompt = buildGoogleCliPrompt(context);
			const command = commandForProvider(provider);
			const args = argsForProvider(provider, model, prompt);
			const result = await runCli(command, args, options);

			if (result.code !== 0) {
				const detail = (result.stderr || result.stdout || `CLI exited with code ${result.code}`).trim();
				throw new Error(formatGoogleCliError(detail, provider));
			}

			const text = provider === "google-gemini-cli"
				? extractGeminiJsonResponse(result.stdout)
				: result.stdout.trim();
			const message = buildAssistantMessage(model, text);
			emitText(stream, message, text);
		} catch (error) {
			emitError(stream, model, error);
		}
	});

	return stream;
}
