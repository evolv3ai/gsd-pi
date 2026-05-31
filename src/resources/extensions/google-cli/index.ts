/**
 * Google local CLI providers.
 *
 * These deliberately use authMode "externalCli": GSD never owns the browser
 * OAuth flow or cached tokens. Users authenticate with the official CLI, then
 * /login activates the provider once the local binary is available.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { GOOGLE_ANTIGRAVITY_MODELS, GOOGLE_GEMINI_CLI_MODELS } from "./models.js";
import { isAntigravityCliReady, isGeminiCliReady } from "./readiness.js";
import { streamViaGoogleCli } from "./stream-adapter.js";

export default function googleCli(pi: ExtensionAPI) {
	pi.registerProvider("google-gemini-cli", {
		name: "Google Gemini CLI",
		authMode: "externalCli",
		api: "google-gemini-cli",
		baseUrl: "local://google-gemini-cli",
		isReady: isGeminiCliReady,
		streamSimple: streamViaGoogleCli,
		models: GOOGLE_GEMINI_CLI_MODELS,
	});

	pi.registerProvider("google-antigravity", {
		name: "Google Antigravity",
		authMode: "externalCli",
		api: "google-antigravity",
		baseUrl: "local://google-antigravity",
		isReady: isAntigravityCliReady,
		streamSimple: streamViaGoogleCli,
		models: GOOGLE_ANTIGRAVITY_MODELS,
	});
}
