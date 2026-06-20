import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.js";

export interface ShellConfig {
	shell: string;
	args: string[];
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", ["bash.exe"], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"] };
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/** GSD compat: normalize Windows NUL redirects for bash compatibility. */
export function sanitizeCommand(command: string): string {
	if (process.platform !== "win32") return command;

	const isDigit = (char: string | undefined): boolean => Boolean(char && char >= "0" && char <= "9");
	const isBoundary = (char: string | undefined): boolean =>
		char === undefined || char === " " || char === "\t" || char === ";" || char === "|" || char === "&" || char === ")";

	let output = "";
	for (let index = 0; index < command.length; ) {
		let cursor = index;
		while (isDigit(command[cursor])) {
			cursor++;
		}
		if (command[cursor] !== ">") {
			output += command[index]!;
			index++;
			continue;
		}

		cursor++;
		if (command[cursor] === ">") {
			cursor++;
		}

		const redirectToken = command.slice(index, cursor);
		let valueStart = cursor;
		while (command[valueStart] === " ") {
			valueStart++;
		}

		const value = command.slice(valueStart, valueStart + 3);
		if (value.toLowerCase() === "nul" && isBoundary(command[valueStart + 3])) {
			output += `${redirectToken} /dev/null`;
			index = valueStart + 3;
			continue;
		}

		output += command[index]!;
		index++;
	}

	return output;
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Grace period (ms) between SIGTERM and SIGKILL.
 * Canonical source of truth for the graceful-kill timing ladder — imported by the
 * async_bash and GSD exec-sandbox kill paths. The pi-agent-core harness keeps a
 * deliberate local mirror (it must not depend on this package); a parity test
 * locks the two. Update both together.
 */
export const SIGKILL_GRACE_MS = 5_000;
/** Hard deadline (ms) after SIGKILL to force-resolve the job promise — consumed by the sync-bash, async_bash, and exec-sandbox kill paths. */
export const HARD_DEADLINE_MS = 3_000;

/**
 * Kill a process and all its children (cross-platform).
 *
 * Returns immediately; the SIGKILL escalation fires asynchronously after `graceMs`,
 * so the target is not guaranteed dead by the time this returns.
 *
 * On Unix: sends SIGTERM immediately, then escalates to SIGKILL after `graceMs`
 * (default: SIGKILL_GRACE_MS = 5 s). The escalation timer is `.unref()`'d so it
 * never keeps the event loop alive after the parent process has nothing else to do.
 *
 * On Windows: there is no reliable graceful signal for the hidden console
 * processes pi spawns (`windowsHide: true` means no window to receive WM_CLOSE
 * and no console for CTRL_BREAK), so `taskkill /T` without /F is a no-op here.
 * We therefore force-terminate the tree immediately with `taskkill /F /T /PID`.
 * Graceful (SIGTERM-first) semantics are Unix-primary; `opts.graceMs` is ignored
 * on Windows.
 */
export function killProcessTree(pid: number, opts?: { graceMs?: number }): void {
	if (process.platform === "win32") {
		// No deliverable graceful signal for hidden console processes — force-kill the
		// whole tree now. (A delayed /F /T after a no-op /T would only add latency,
		// regressing the old immediate-kill behavior.) opts.graceMs is intentionally
		// unused on Windows.
		try {
			const tk = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
			tk.unref();
		} catch {
			// Ignore — process may already be gone
		}
	} else {
		// Unix: SIGTERM → grace window → SIGKILL
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// -pid (process group) failed — fall back to direct pid
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Process already dead — no escalation needed
				return;
			}
		}
		// Escalate to SIGKILL after the grace period.
		// The timer is unref'd so it never prevents the event loop from exiting.
		const t = setTimeout(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Process already dead
				}
			}
		}, opts?.graceMs ?? SIGKILL_GRACE_MS);
		if (typeof t === "object" && "unref" in t) t.unref();
	}
}
