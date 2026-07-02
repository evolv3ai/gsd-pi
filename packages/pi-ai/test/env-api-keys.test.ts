import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getApiKeyEnvVars, getEnvApiKey } from "../src/env-api-keys.ts";

const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalAnthropicVertexProjectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
const originalCursorApiKey = process.env.CURSOR_API_KEY;
const originalGoogleCloudProject = process.env.GOOGLE_CLOUD_PROJECT;
const originalGcloudProject = process.env.GCLOUD_PROJECT;

afterEach(() => {
	if (originalCopilotGitHubToken === undefined) {
		delete process.env.COPILOT_GITHUB_TOKEN;
	} else {
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}

	if (originalGitHubToken === undefined) {
		delete process.env.GITHUB_TOKEN;
	} else {
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}

	if (originalAnthropicVertexProjectId === undefined) {
		delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
	} else {
		process.env.ANTHROPIC_VERTEX_PROJECT_ID = originalAnthropicVertexProjectId;
	}

	if (originalCursorApiKey === undefined) {
		delete process.env.CURSOR_API_KEY;
	} else {
		process.env.CURSOR_API_KEY = originalCursorApiKey;
	}

	if (originalGoogleCloudProject === undefined) {
		delete process.env.GOOGLE_CLOUD_PROJECT;
	} else {
		process.env.GOOGLE_CLOUD_PROJECT = originalGoogleCloudProject;
	}

	if (originalGcloudProject === undefined) {
		delete process.env.GCLOUD_PROJECT;
	} else {
		process.env.GCLOUD_PROJECT = originalGcloudProject;
	}
});

describe("environment API keys", () => {
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		delete process.env.COPILOT_GITHUB_TOKEN;
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toBeUndefined();
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	it("resolves Cursor Agent credentials from CURSOR_API_KEY", () => {
		process.env.CURSOR_API_KEY = "cursor-token";

		expect(getApiKeyEnvVars("cursor-agent")).toEqual(["CURSOR_API_KEY"]);
		expect(findEnvKeys("cursor-agent")).toEqual(["CURSOR_API_KEY"]);
		expect(getEnvApiKey("cursor-agent")).toBe("cursor-token");
	});

	it("treats ANTHROPIC_VERTEX_PROJECT_ID as Anthropic Vertex auth", () => {
		process.env.ANTHROPIC_VERTEX_PROJECT_ID = "vertex-project";
		delete process.env.GOOGLE_CLOUD_PROJECT;
		delete process.env.GCLOUD_PROJECT;

		expect(getApiKeyEnvVars("anthropic-vertex")).toEqual(["ANTHROPIC_VERTEX_PROJECT_ID"]);
		expect(findEnvKeys("anthropic-vertex")).toEqual(["ANTHROPIC_VERTEX_PROJECT_ID"]);
		expect(getEnvApiKey("anthropic-vertex")).toBe("<authenticated>");
	});
});
