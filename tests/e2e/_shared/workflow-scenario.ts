import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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
		const fullPath = join(this.projectDir, relativePath);
		if (existsSync(fullPath)) return;
		// Flat-phase fallback: translate old milestones/ paths to phases/ equivalents.
		// Old: .gsd/milestones/M001/M001-VALIDATION.md → .gsd/phases/*/01-VALIDATION.md
		// Old: .gsd/milestones/M001/slices/S01/S01-SUMMARY.md → .gsd/phases/*/01-01-SUMMARY.md
		// Old: .gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md → .gsd/phases/*/T01-SUMMARY.md
		if (relativePath.includes("milestones/")) {
			const phasesDir = join(this.projectDir, ".gsd", "phases");
			if (existsSync(phasesDir)) {
				try {
					// Extract the milestone id from the path (e.g. "M001", "M002") so we
					// can derive the correct flat-phase numeric prefix (01, 02, …).
					const milestoneIdMatch = relativePath.match(/milestones\/(M(\d+))\//);
					const phasePrefix = milestoneIdMatch
						? String(parseInt(milestoneIdMatch[2]!, 10)).padStart(2, "0")
						: "01";
					for (const phaseEntry of readdirSync(phasesDir, { withFileTypes: true })) {
						if (!phaseEntry.isDirectory()) continue;
						const phaseDir = join(phasesDir, phaseEntry.name);
						// Extract the file suffix from the old path
						const oldFileName = relativePath.split("/").pop()!;
						// Try old filename as-is in the phase dir
						if (existsSync(join(phaseDir, oldFileName))) return;
						// Try flat-phase naming: M001-SUFFIX.md → 01-SUFFIX.md
						// Use the milestone's actual phase number (not hardcoded "01").
						const flatFileName = oldFileName.replace(/^M\d+-/, `${phasePrefix}-`);
						if (existsSync(join(phaseDir, flatFileName))) return;
						// Try slice file: S01-SUMMARY.md → NN-01-SUMMARY.md
						const sliceMatch = oldFileName.match(/^S0*(\d+)-(.+\.md)$/);
						if (sliceMatch) {
							const planNum = parseInt(sliceMatch[1]!, 10);
							const suffix = sliceMatch[2];
							const planFile = `${phasePrefix}-${String(planNum).padStart(2, "0")}-${suffix}`;
							if (existsSync(join(phaseDir, planFile))) return;
						}
						// Try task file: T01-SUMMARY.md as-is (stays in phase dir)
						if (oldFileName.match(/^T\d+-/)) {
							if (existsSync(join(phaseDir, oldFileName))) return;
						}
					}
				} catch {
					// unreadable phases dir
				}
			}
		}
		assert.ok(existsSync(fullPath), message);
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
