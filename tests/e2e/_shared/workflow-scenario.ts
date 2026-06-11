import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { TranscriptTurn } from "./fake-llm.ts";

export type JsonEvent = Record<string, unknown>;

export function smokeBinaryAvailable(): { ok: boolean; reason?: string } {
	const bin = process.env.GSD_SMOKE_BINARY;
	if (!bin) return { ok: false, reason: "GSD_SMOKE_BINARY not set; build with `npm run build:core` and re-export." };
	if (!existsSync(bin)) return { ok: false, reason: `binary not found at ${bin}` };
	return { ok: true };
}

export function commitProjectFiles(dir: string, files: readonly string[], message: string): void {
	execFileSync("git", ["add", ...files], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "pipe" });
}

export function notificationMessages(events: readonly JsonEvent[]): string[] {
	return events
		.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
		.map((event) => String(event.message ?? ""));
}

export function toolNames(events: readonly JsonEvent[]): string[] {
	return events
		.filter((event) => event.type === "tool_execution_end")
		.map((event) => String(event.toolName ?? ""));
}

export function toolErrors(events: readonly JsonEvent[]): string[] {
	return events
		.filter((event) => event.type === "tool_execution_end")
		.filter((event) => event.isError === true || (event.result as { isError?: boolean } | undefined)?.isError === true)
		.map((event) => `${String(event.toolName ?? "unknown")}: ${JSON.stringify(event.result ?? {})}`);
}

export function scalar(
	db: DatabaseSync,
	sql: string,
	params: Record<string, string> = {},
): string | null {
	const row = db.prepare(sql).get(params) as { value?: string | number | null } | undefined;
	return row?.value == null ? null : String(row.value);
}

export class WorkflowOutcomeProbe {
	readonly projectDir: string;
	readonly events: readonly JsonEvent[];
	readonly notifications: string[];

	constructor(
		projectDir: string,
		events: readonly JsonEvent[],
	) {
		this.projectDir = projectDir;
		this.events = events;
		this.notifications = notificationMessages(events);
	}

	assertNoOperatorFailures(): void {
		const badOperatorSignals = this.notifications.filter((message) =>
			/blocked:|failed|cannot complete|cannot validate|stopped with an issue/i.test(message),
		);
		assert.deepEqual(badOperatorSignals, [], `unexpected blocked/error operator signals: ${badOperatorSignals.join("\n")}`);
	}

	assertNoToolErrors(): void {
		const errors = toolErrors(this.events);
		assert.deepEqual(errors, [], `unexpected tool errors:\n${errors.join("\n")}`);
	}

	assertCompletionNotification(pattern: RegExp): void {
		assert.ok(
			this.notifications.some((message) => /auto-mode stopped/i.test(message) && pattern.test(message)),
			`expected terminal auto-mode completion notification, got:\n${this.notifications.join("\n")}`,
		);
	}

	assertArtifact(relativePath: string, message: string): void {
		assert.ok(existsSync(join(this.projectDir, relativePath)), message);
	}

	openDb(t: { after: (fn: () => void) => void }): DatabaseSync {
		const db = new DatabaseSync(join(this.projectDir, ".gsd", "gsd.db"));
		t.after(() => db.close());
		return db;
	}
}

export class WorkflowTranscriptBuilder {
	private readonly turns: TranscriptTurn[] = [];

	addTool(
		name: string,
		input: Record<string, unknown>,
		id: string,
		expect?: TranscriptTurn["expect"],
	): this {
		appendToolTurn(this.turns, name, input, id, expect);
		return this;
	}

	addText(text: string, expect?: TranscriptTurn["expect"]): this {
		appendTextTurn(this.turns, text, expect);
		return this;
	}

	toTurns(): TranscriptTurn[] {
		return this.turns;
	}
}

export function appendToolTurn(
	turns: TranscriptTurn[],
	name: string,
	input: Record<string, unknown>,
	id: string,
	expect?: TranscriptTurn["expect"],
): void {
	turns.push({
		turn: turns.length + 1,
		...(expect ? { expect } : {}),
		emit: { kind: "tool_use", calls: [{ id, name, input }] },
	});
}

export function appendTextTurn(
	turns: TranscriptTurn[],
	text: string,
	expect?: TranscriptTurn["expect"],
): void {
	turns.push({
		turn: turns.length + 1,
		...(expect ? { expect } : {}),
		emit: { kind: "text", text },
	});
}
