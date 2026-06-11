import assert from "node:assert/strict";

import {
	getUatBrowserToolSupportError,
	hasUatBrowserToolSurface,
	type UatType,
} from "../uat-policy.ts";

export const BROWSER_AUTOMATION_CONTRACT_TOOLS = {
	piProvider: ["read", "browser_navigate"],
	externalMcpClient: ["read", "mcp__gsd-browser__browser_navigate"],
	externalMcpWildcard: ["read", "mcp__gsd-browser__*"],
	otherBrowserMcp: ["read", "mcp__browser-uat__*"],
	workflowOnly: ["read", "mcp__gsd-workflow__*"],
	withoutBrowser: ["read", "gsd_uat_exec"],
} as const;

export function assertBrowserAutomationContractAvailable(tools: readonly string[]): void {
	assert.equal(hasUatBrowserToolSurface(tools), true, `${tools.join(", ")} should satisfy the Browser Automation Contract`);
}

export function assertBrowserAutomationContractMissing(tools: readonly string[] | undefined): void {
	assert.equal(hasUatBrowserToolSurface(tools), false, `${tools?.join(", ") ?? "undefined"} should not satisfy the Browser Automation Contract`);
}

export function assertBrowserBackedUatCanDispatch(options: {
	uatType: UatType;
	activeTools: readonly string[] | undefined;
	registeredTools?: readonly string[];
}): void {
	assert.equal(
		getUatBrowserToolSupportError({
			...options,
			milestoneId: "M001",
			sliceId: "S01",
		}),
		null,
	);
}
