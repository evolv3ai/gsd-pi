// Project/App: gsd-pi
// File Purpose: Tests for connected chat turn detection.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Text } from "@gsd/pi-tui";

import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { chatTurnFollowsUser } from "./chat-turn-connect.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

initTheme("dark", false);

describe("chatTurnFollowsUser", () => {
	test("treats tool rows after a user message as part of the pending assistant turn", () => {
		// Variant A plain transcript does not use connected rails — chatTurnFollowsUser is a no-op.
		const tool = new ToolExecutionComponent(
			"read",
			{ path: "README.md" },
			{},
			undefined,
			{ requestRender() {} } as any,
		);

		assert.equal(chatTurnFollowsUser([new UserMessageComponent("Inspect this"), tool]), false);
	});

	test("does not bridge past a previous assistant-like message", () => {
		const tool = new ToolExecutionComponent(
			"read",
			{ path: "README.md" },
			{},
			undefined,
			{ requestRender() {} } as any,
		);

		assert.equal(
			chatTurnFollowsUser([new UserMessageComponent("Inspect this"), new Text("assistant"), tool]),
			false,
		);
	});
});
