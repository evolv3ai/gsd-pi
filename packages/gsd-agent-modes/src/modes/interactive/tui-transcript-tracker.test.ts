import assert from "node:assert/strict";
import test from "node:test";

import { createInitialTranscriptState } from "@gsd/agent-core";

import { applyAgentEventToTranscript } from "./tui-transcript-tracker.js";

test("applyAgentEventToTranscript: message_start user queues pending message", () => {
	let state = createInitialTranscriptState();
	state = applyAgentEventToTranscript(state, {
		type: "message_start",
		message: { role: "user", content: "hi" },
	} as any);
	assert.equal(state.pendingUserMessage?.role, "user");
});
