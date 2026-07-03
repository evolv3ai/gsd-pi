import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { CURSOR_AGENT_MODELS } from "./models.js";
import { isCursorAgentReady } from "./readiness.js";
import { streamViaCursorAgent } from "./stream-adapter.js";

export default function cursorCli(pi: ExtensionAPI): void {
	if (process.env.GSD_CURSOR_DISABLE === "1") return;

	pi.registerProvider("cursor-agent", {
		name: "Cursor Agent",
		authMode: "externalCli",
		api: "cursor-stream-json",
		baseUrl: "local://cursor-agent",
		isReady: isCursorAgentReady,
		streamSimple: streamViaCursorAgent,
		models: CURSOR_AGENT_MODELS,
	});
}
