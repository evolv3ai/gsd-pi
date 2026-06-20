import assert from "node:assert";
import { describe, it } from "node:test";
import { DISABLE_MOUSE, ENABLE_MOUSE } from "../src/mouse.ts";
import { ProcessTerminal, shouldEnableMouseReporting } from "../src/terminal.ts";

function withProcessTerminalHarness(env: Record<string, string | undefined>, run: (writes: string[]) => void): void {
	const previousStdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const previousStdinIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
	const previousSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	const previousSetEncoding = process.stdin.setEncoding;
	const previousResume = process.stdin.resume;
	const previousPause = process.stdin.pause;
	const previousWrite = process.stdout.write;
	const previousKill = process.kill;
	const previousSetTimeout = globalThis.setTimeout;
	const previousMouseEnv = process.env.PI_TUI_MOUSE;
	const writes: string[] = [];
	let terminal: ProcessTerminal | undefined;

	try {
		if (env.PI_TUI_MOUSE === undefined) {
			delete process.env.PI_TUI_MOUSE;
		} else {
			process.env.PI_TUI_MOUSE = env.PI_TUI_MOUSE;
		}

		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "isRaw", { value: false, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
		process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
		process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
		process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
		process.stdout.write = ((data: string | Uint8Array) => {
			writes.push(typeof data === "string" ? data : data.toString());
			return true;
		}) as typeof process.stdout.write;
		process.kill = (() => true) as typeof process.kill;
		globalThis.setTimeout = (() => 0) as unknown as typeof globalThis.setTimeout;

		terminal = new ProcessTerminal();
		terminal.start(() => {}, () => {});
		run(writes);
	} finally {
		terminal?.stop();

		if (previousMouseEnv === undefined) {
			delete process.env.PI_TUI_MOUSE;
		} else {
			process.env.PI_TUI_MOUSE = previousMouseEnv;
		}
		if (previousStdoutIsTty) {
			Object.defineProperty(process.stdout, "isTTY", previousStdoutIsTty);
		} else {
			Reflect.deleteProperty(process.stdout, "isTTY");
		}
		if (previousStdinIsRaw) {
			Object.defineProperty(process.stdin, "isRaw", previousStdinIsRaw);
		} else {
			Reflect.deleteProperty(process.stdin, "isRaw");
		}
		if (previousSetRawMode) {
			Object.defineProperty(process.stdin, "setRawMode", previousSetRawMode);
		} else {
			Reflect.deleteProperty(process.stdin, "setRawMode");
		}
		process.stdin.setEncoding = previousSetEncoding;
		process.stdin.resume = previousResume;
		process.stdin.pause = previousPause;
		process.stdout.write = previousWrite;
		process.kill = previousKill;
		globalThis.setTimeout = previousSetTimeout;
	}
}

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});

describe("shouldEnableMouseReporting", () => {
	it("keeps native terminal selection by default", () => {
		assert.equal(shouldEnableMouseReporting({}), false);
		assert.equal(shouldEnableMouseReporting({ PI_TUI_MOUSE: "0" }), false);
	});

	it("enables terminal mouse reporting only when explicitly requested", () => {
		assert.equal(shouldEnableMouseReporting({ PI_TUI_MOUSE: "1" }), true);
	});
});

describe("ProcessTerminal mouse reporting", () => {
	it("does not emit mouse tracking enable sequences by default", () => {
		withProcessTerminalHarness({}, (writes) => {
			const output = writes.join("");
			assert.equal(output.includes(ENABLE_MOUSE), false);
			assert.equal(output.includes("\x1b[?1002h"), false);
			assert.equal(output.includes("\x1b[?1003h"), false);
		});
	});

	it("emits and clears mouse reporting only when explicitly enabled", () => {
		let capturedWrites: string[] = [];
		withProcessTerminalHarness({ PI_TUI_MOUSE: "1" }, (writes) => {
			capturedWrites = writes;
			assert.equal(writes.join("").includes(ENABLE_MOUSE), true);
		});

		const output = capturedWrites.join("");
		assert.equal(output.includes(DISABLE_MOUSE), true);
	});
});
