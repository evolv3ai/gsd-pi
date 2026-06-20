/**
 * Unit tests for killProcessTree graceful escalation ladder.
 *
 * Case (a): SIGTERM-cooperative child — exits quickly without needing SIGKILL.
 * Case (b): SIGTERM-resistant child — survives SIGTERM but is dead after SIGKILL grace.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessTree } from "./shell.js";

// These tests spawn POSIX `sleep`/`bash` and assert SIGTERM-then-SIGKILL timing,
// which is Unix-primary; on Windows killProcessTree force-kills via taskkill and
// the POSIX commands don't exist, so skip there.
const skipOnWindows = process.platform === "win32" ? "Unix-primary graceful semantics" : false;

// ------------------------------------------------------------------
// Helper: poll until the process is dead (ESRCH) or deadline exceeded.
// Returns elapsed ms on success; throws if wall-clock limit exceeded.
// ------------------------------------------------------------------
async function waitUntilDead(
	pid: number,
	deadlineMs: number,
	pollIntervalMs = 50,
): Promise<number> {
	const start = Date.now();
	return new Promise<number>((resolve, reject) => {
		const interval = setInterval(() => {
			const elapsed = Date.now() - start;
			try {
				process.kill(pid, 0); // throws ESRCH when dead
			} catch {
				clearInterval(interval);
				resolve(elapsed);
				return;
			}
			if (elapsed > deadlineMs) {
				clearInterval(interval);
				reject(new Error(`Process ${pid} still alive after ${elapsed}ms`));
			}
		}, pollIntervalMs);
		if (typeof interval === "object" && "unref" in interval) interval.unref();
	});
}

// ------------------------------------------------------------------
// Helper: check whether a pid is currently alive.
// ------------------------------------------------------------------
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------
// Helper: poll until a file exists or the deadline is exceeded. Used as a
// handshake that a spawned shell has reached a known point in its script
// (e.g. AFTER installing its SIGTERM trap) — far more robust than a blind
// fixed sleep, which races shell startup under heavy parallel load.
// ------------------------------------------------------------------
async function waitForFile(path: string, deadlineMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		if (existsSync(path)) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return existsSync(path);
}

// ------------------------------------------------------------------
// Case (a): SIGTERM-cooperative child exits promptly (no SIGKILL needed)
// ------------------------------------------------------------------
test("killProcessTree: SIGTERM-cooperative child exits well under the grace window", { timeout: 8_000, skip: skipOnWindows }, async (t) => {
	const child = spawn("sleep", ["60"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	const pid = child.pid!;
	assert.ok(pid, "child pid should be defined");
	// Reap the child if an assertion throws before it dies, so a failed run never
	// leaks a `sleep 60` onto the CI box.
	t.after(() => {
		try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
	});

	// Give the process a moment to fully start
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(isAlive(pid), "child should be alive before kill");

	killProcessTree(pid);

	// Should die well before the grace window (1500ms is generous for SIGTERM)
	const elapsed = await Promise.race([
		waitUntilDead(pid, 4_000),
		new Promise<never>((_, reject) => {
			const t = setTimeout(
				() => reject(new Error(`Wall-clock guard triggered — child ${pid} still alive after 4s`)),
				4_000,
			);
			if (typeof t === "object" && "unref" in t) t.unref();
		}),
	]);

	assert.ok(
		elapsed < 1_500,
		`Expected child to die within 1500ms of SIGTERM, but took ${elapsed}ms`,
	);
});

// ------------------------------------------------------------------
// Case (b): SIGTERM-resistant child survives SIGTERM but dies via SIGKILL
// ------------------------------------------------------------------
test("killProcessTree: SIGTERM-resistant child dies after grace window but not immediately", { timeout: 10_000, skip: skipOnWindows }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "kill-process-tree-"));
	const trapReadyFile = join(dir, "trap-ready");

	// Install the SIGTERM trap FIRST, then signal readiness by creating the
	// handshake file, then loop forever holding the group open. The loop form
	// (rather than `trap '' TERM; sleep 60`) keeps bash itself — the process-group
	// leader — the SIGTERM-immune process, instead of relying on bash exec-
	// optimizing into `sleep` and the SIG_IGN disposition surviving execve.
	const child = spawn(
		"bash",
		["-c", `trap '' TERM; : > '${trapReadyFile}'; while true; do sleep 1; done`],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();

	const pid = child.pid!;
	assert.ok(pid, "child pid should be defined");
	// Reap the SIGTERM-immune child if an assertion throws before SIGKILL fires.
	t.after(() => {
		try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
		rmSync(dir, { recursive: true, force: true });
	});

	// Handshake: wait until the child has ACTUALLY installed its SIGTERM trap
	// (it writes trapReadyFile immediately after `trap`). A blind fixed sleep here
	// races bash startup under heavy parallel load — if SIGTERM lands before the
	// trap is set, the child dies on SIGTERM and the "survives SIGTERM" assertion
	// flakes. Polling the handshake file removes that race.
	assert.ok(await waitForFile(trapReadyFile, 5_000), "child should install its SIGTERM trap and signal readiness");
	assert.ok(isAlive(pid), "SIGTERM-resistant child should be alive before kill");

	const GRACE_MS = 600; // short grace keeps the test fast
	const startMs = Date.now();
	killProcessTree(pid, { graceMs: GRACE_MS });

	// ~300ms after SIGTERM: the child should still be alive (it ignores SIGTERM).
	// The trap is guaranteed installed (handshake above), so this is no longer racy.
	await new Promise((r) => setTimeout(r, 300));
	const aliveAtMidpoint = isAlive(pid);

	// Wait for death (SIGKILL fires at ~600ms); generous upper bound of 4000ms
	const elapsed = await Promise.race([
		waitUntilDead(pid, 4_000),
		new Promise<never>((_, reject) => {
			const t = setTimeout(
				() => reject(new Error(`Wall-clock guard triggered — child ${pid} still alive after 4s post-kill`)),
				4_000,
			);
			if (typeof t === "object" && "unref" in t) t.unref();
		}),
	]);

	const totalElapsed = Date.now() - startMs;

	assert.ok(
		aliveAtMidpoint,
		"SIGTERM-resistant child should still be alive ~300ms after SIGTERM (before SIGKILL fires)",
	);
	// Lower bound proves SIGKILL did NOT fire immediately (it waited for the grace
	// window); upper bound proves it fired roughly AT the grace window, not just
	// "eventually". A loose [300ms, 4000ms] band would pass even if SIGKILL slipped
	// far past GRACE_MS, so the window is tied to GRACE_MS with CI jitter slack.
	assert.ok(
		totalElapsed >= GRACE_MS * 0.8 && totalElapsed <= GRACE_MS + 2_000,
		`Expected child to die in the SIGKILL grace window (~${GRACE_MS}ms), but elapsed=${totalElapsed}ms`,
	);
});
