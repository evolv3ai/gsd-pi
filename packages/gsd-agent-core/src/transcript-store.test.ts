import assert from "node:assert/strict";
import test from "node:test";

import {
	applyTextDelta,
	applyThinkingDelta,
	completeTurn,
	createInitialTranscriptState,
	getFlatTranscript,
	MAX_TRANSCRIPT_TURNS,
	pushPendingUserMessage,
	type CompletedTurn,
} from "./transcript-store.js";

test("turn FSM: text delta accumulates then completes into a turn", () => {
	let state = createInitialTranscriptState();
	state = applyTextDelta(state, "Hello ");
	state = applyTextDelta(state, "world");
	state = completeTurn(state);

	assert.equal(state.completedTurns.length, 1);
	assert.equal(state.completedTurns[0]?.segments[0]?.kind, "text");
	if (state.completedTurns[0]?.segments[0]?.kind === "text") {
		assert.equal(state.completedTurns[0].segments[0].content, "Hello world");
	}
	assert.equal(state.streamingAssistantText, "");
});

test("getFlatTranscript extracts text segments only", () => {
	const turns: CompletedTurn[] = [
		{
			segments: [
				{ kind: "thinking", content: "hmm" },
				{ kind: "text", content: "Answer" },
			],
		},
	];
	assert.deepEqual(getFlatTranscript(turns), ["Answer"]);
});

test("MAX_TRANSCRIPT_TURNS caps completed turns", () => {
	let state = createInitialTranscriptState();
	for (let i = 0; i < MAX_TRANSCRIPT_TURNS + 5; i++) {
		state = pushPendingUserMessage(state, { role: "user", content: `msg ${i}` });
		state = applyTextDelta(state, `reply ${i}`);
		state = completeTurn(state);
	}
	assert.equal(state.completedTurns.length, MAX_TRANSCRIPT_TURNS);
});

test("thinking then text delta finalizes thinking segment first", () => {
	let state = createInitialTranscriptState();
	state = applyThinkingDelta(state, "plan");
	state = applyTextDelta(state, "go");
	state = completeTurn(state);
	assert.equal(state.completedTurns[0]?.segments.length, 2);
	assert.equal(state.completedTurns[0]?.segments[0]?.kind, "thinking");
	assert.equal(state.completedTurns[0]?.segments[1]?.kind, "text");
});

test("empty turn completion drops the pending user message", () => {
	let state = createInitialTranscriptState();
	state = pushPendingUserMessage(state, { role: "user", content: "aborted prompt" });
	state = completeTurn(state);
	state = applyTextDelta(state, "next response");
	state = completeTurn(state);

	assert.equal(state.completedTurns.length, 1);
	assert.equal(state.completedTurns[0]?.userMessage, undefined);
});
